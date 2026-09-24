/**
 * Vote-to-kick ballots on the shared `recflare` D1 database.
 *
 * One row per vote cast: who was voted on, in which game session, by whom, and which way.
 * Append-only like the `report` and `warning` tables (see reports-db.ts), so a vote is a
 * record of what happened rather than a tally that gets rewritten — the tally is computed
 * from the rows.
 *
 * The rows outlive the vote, but not by much: the `rooms` worker's cron deletes ballots
 * older than 5 minutes (its `ROOM_VOTE_RETENTION_MS`), which is the longest anything here
 * looks back — `VOTE_CALL_COOLDOWN_MS`. Nothing deletes them when a session ends, and
 * nothing needs to: a ballot is keyed to its `game_session_id`, and instance ids are not
 * reused, so an old session's votes can never be counted into a new one's. Raising the
 * cooldown means raising that retention too.
 *
 * The `api` worker owns this schema/migration (migrations/0023_room_vote.sql and
 * 0026_room_vote_init.sql, applied under
 * its own `migrations_table` so it doesn't clash with the other workers' migrations that
 * share the database).
 */

/** Schema DDL (mirror of migrations/0023_room_vote.sql + 0026_room_vote_init.sql). */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS room_vote (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		game_session_id INTEGER NOT NULL,
		player_id INTEGER NOT NULL,
		response INTEGER NOT NULL,
		voter_id INTEGER NOT NULL,
		voted_at TEXT NOT NULL,
		init INTEGER NOT NULL DEFAULT 0
	)`,
	// The tally's own query: every ballot cast against one player in one session.
	`CREATE INDEX IF NOT EXISTS idx_room_vote_subject ON room_vote (game_session_id, player_id)`,
	// The caller throttle's query: the last vote one player CALLED.
	`CREATE INDEX IF NOT EXISTS idx_room_vote_caller ON room_vote (voter_id, voted_at) WHERE init = 1`,
]

/**
 * How long a vote stays open once it is called. Every ballot posted inside it is an answer to
 * THAT vote; the first one posted after it is a new vote, with a prompt of its own.
 */
export const VOTE_WINDOW_MS = 60_000

/** How long a player must wait after calling a vote before they may call another, anywhere. */
export const VOTE_CALL_COOLDOWN_MS = 5 * 60_000

/**
 * One cast ballot. `response` is 1 for yes (kick them) and 0 for no. `init` is 1 on the ballot
 * that CALLED the vote — the first cast against this player in this session once no vote was
 * open — and 0 on every answer to it. The client posts both to the same endpoint and nothing
 * in the body tells them apart, so the row is where a vote's start is recorded.
 */
export interface RoomVoteRow {
	id: number
	game_session_id: number
	player_id: number
	response: number
	voter_id: number
	voted_at: string
	init: number
}

/** A ballot as cast — the timestamp is the table's. */
export interface NewRoomVote {
	gameSessionId: number
	/** The player being voted on. */
	playerId: number
	voterId: number
	/** True to kick them. */
	response: boolean
	/** True when this ballot calls the vote rather than answering one. */
	init: boolean
}

/** Record one cast ballot, returning the stored row. */
export async function recordRoomVote(db: D1Database, input: NewRoomVote): Promise<RoomVoteRow> {
	const row = await db
		.prepare(
			`INSERT INTO room_vote (game_session_id, player_id, response, voter_id, voted_at, init)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
			 RETURNING *`
		)
		.bind(
			input.gameSessionId,
			input.playerId,
			input.response ? 1 : 0,
			input.voterId,
			new Date().toISOString(),
			input.init ? 1 : 0
		)
		.first<RoomVoteRow>()
	// RETURNING always yields the inserted row.
	return row!
}

/**
 * The ballot that called the vote currently open on this player in this session — the latest
 * `init` row, if it was cast inside `VOTE_WINDOW_MS` — or null when no vote is open.
 */
export async function getOpenVote(
	db: D1Database,
	gameSessionId: number,
	playerId: number,
	now = Date.now()
): Promise<RoomVoteRow | null> {
	return db
		.prepare(
			`SELECT * FROM room_vote
			 WHERE game_session_id = ?1 AND player_id = ?2 AND init = 1 AND voted_at > ?3
			 ORDER BY id DESC LIMIT 1`
		)
		.bind(gameSessionId, playerId, new Date(now - VOTE_WINDOW_MS).toISOString())
		.first<RoomVoteRow>()
}

/**
 * Whether `voterId` called a vote — any vote, in any session — within `VOTE_CALL_COOLDOWN_MS`.
 * Only CALLING is throttled: answering a vote someone else called is never refused.
 */
export async function isOnVoteCooldown(
	db: D1Database,
	voterId: number,
	now = Date.now()
): Promise<boolean> {
	const row = await db
		.prepare(`SELECT 1 FROM room_vote WHERE voter_id = ?1 AND init = 1 AND voted_at > ?2 LIMIT 1`)
		.bind(voterId, new Date(now - VOTE_CALL_COOLDOWN_MS).toISOString())
		.first()
	return row !== null
}

/**
 * How many DISTINCT players have voted to kick this player out of this session.
 *
 * Distinct voters, not rows, and only each voter's LATEST ballot: the table is append-only,
 * so a player who votes twice leaves two rows, and counting rows would let one person carry
 * a vote on their own by posting it repeatedly. Counting their latest also lets someone
 * change their mind — a yes followed by a no is a no.
 *
 * `MAX(id)` picks the latest rather than `MAX(voted_at)`: two ballots cast in the same
 * millisecond carry the same timestamp, and the id is the order they were actually recorded
 * in.
 *
 * Only ballots from `sinceId` on count — the id of the `init` row that called THIS vote. A
 * vote that expired without carrying leaves its yes ballots behind, and without the bound
 * they would carry the next vote called on the same player.
 */
export async function countKickVotes(
	db: D1Database,
	gameSessionId: number,
	playerId: number,
	sinceId: number
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS yes FROM (
				 SELECT response FROM room_vote
				 WHERE game_session_id = ?1 AND player_id = ?2
					 AND id IN (
						 SELECT MAX(id) FROM room_vote
						 WHERE game_session_id = ?1 AND player_id = ?2 AND id >= ?3
						 GROUP BY voter_id
					 )
			 ) WHERE response = 1`
		)
		.bind(gameSessionId, playerId, sinceId)
		.first<{ yes: number }>()
	return row?.yes ?? 0
}

/**
 * Whether `yesVotes` carries a vote in a session holding `playerCount` players: STRICTLY more
 * than half. A tie is not a majority, and a session whose presence count has somehow reached
 * zero can never carry one — `0 > 0` is false — rather than every vote passing unopposed.
 */
export const isKickMajority = (yesVotes: number, playerCount: number): boolean =>
	playerCount > 0 && yesVotes > playerCount / 2
