/**
 * The audit log on the shared `recflare` D1 database — one row per privileged action a
 * staff account took, written by whoever performs the action.
 *
 * This is not the worker log. `logger.info` lines are for reading during an incident: they
 * are sampled, they expire, and nothing can be asked of them later. An audit row is the
 * durable answer to "who sent that, and when" — the kind of question that arrives weeks
 * after the fact, about an action (a coach message, a maintenance broadcast) that left no
 * other trace on the database at all.
 *
 * `player_id` is the ACTOR — the staff account that made the call — not whoever the action
 * was aimed at. A target, where there is one, lives inside `data` along with the rest of
 * what was asked for; the broadcasts have no target at all, so a column for one would be
 * null on half the table and could not be the thing every row is filed under.
 *
 * `data` is JSON as TEXT, and deliberately unstructured: each action records what it was
 * asked to do, and those shapes have nothing in common beyond being worth keeping. Read it
 * with `JSON.parse`; nothing queries INTO it (D1 has `json_extract` if that ever changes).
 *
 * The `api` worker owns this schema/migration (`apps/api/migrations/0024_audit_log.sql`,
 * applied under its own `migrations_table` so it doesn't clash with the other workers'
 * migrations that share the database). {@link AUDIT_LOG_SCHEMA_DDL} mirrors that migration
 * so a worker that writes the table but doesn't migrate it — `notify` — can build it
 * directly in its tests.
 */

/**
 * How much serialized `data` one row keeps.
 *
 * A body arrives from a caller, so its size is theirs to choose, and an audit row that
 * carries a multi-megabyte payload costs the same storage whether or not anyone ever reads
 * it. Over the cap the row keeps the head of the JSON and says so (see {@link writeAuditLog})
 * rather than dropping `data` altogether: a truncated record still answers what was done,
 * and a row that silently lost its payload does not.
 */
export const MAX_AUDIT_DATA_CHARS = 4096

/** Schema DDL (mirror of apps/api/migrations/0024_audit_log.sql). */
export const AUDIT_LOG_SCHEMA_DDL: string[] = [
	// `audit_log_id` is a plain rowid alias, not AUTOINCREMENT: the id never leaves the
	// server (unlike `notification`'s, which is handed to the client), and nothing deletes
	// from this table, so there are no freed rowids to be reused.
	//
	// `date` is an ISO-8601 UTC string, which is fixed-width and so orders correctly under
	// SQLite's plain string comparison — though reads order by `audit_log_id`, which is
	// monotonic and doesn't tie when two actions land in the same millisecond.
	//
	// `data` is nullable: an action whose whole content is its name (and its actor, and its
	// time) has nothing to put there, and null says that where `{}` would only look like a
	// payload that went missing.
	`CREATE TABLE IF NOT EXISTS audit_log (
		audit_log_id INTEGER PRIMARY KEY,
		player_id INTEGER NOT NULL,
		action TEXT NOT NULL,
		data TEXT,
		date TEXT NOT NULL
	)`,
	// The two ways anyone asks this table anything: everything one staffer did, and every
	// time a given action was taken. Both newest-first, which is the order an audit trail is
	// read in.
	`CREATE INDEX IF NOT EXISTS idx_audit_log_player ON audit_log (player_id, audit_log_id DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action, audit_log_id DESC)`,
]

/** What a caller records. The id and the timestamp are minted here. */
export interface NewAuditLogEntry {
	/** The staff account that took the action — the actor, never the target. */
	playerId: number
	/**
	 * What they did, as a stable `snake_case` verb: `coach_message`, `broadcast`. It is what
	 * the log is filtered on, so it names the ACTION and not the outcome — a call that was
	 * refused is the same action as one that went through, distinguished by what `data` says
	 * about it.
	 */
	action: string
	/** Whatever describes this particular action. Serialized to JSON; omit where there is none. */
	data?: unknown
}

/**
 * Record one action.
 *
 * Callers should not let a failure here fail the action itself: by the time this runs the
 * thing has usually already happened, so throwing would report a coach message as refused
 * after it was delivered. Catch it and log loudly instead — a gap in the audit trail is
 * worth an error line, but it is not worth lying to the caller about what took place.
 */
export async function writeAuditLog(db: D1Database, entry: NewAuditLogEntry): Promise<void> {
	await db
		.prepare(`INSERT INTO audit_log (player_id, action, data, date) VALUES (?1, ?2, ?3, ?4)`)
		.bind(entry.playerId, entry.action, serializeAuditData(entry.data), new Date().toISOString())
		.run()
}

/**
 * `data` as it goes into the column: JSON text, null when there is nothing to say, and a
 * self-describing stand-in when what there is exceeds {@link MAX_AUDIT_DATA_CHARS}.
 *
 * The stand-in is itself valid JSON, so every non-null `data` in the table parses — a reader
 * never has to guess whether a row was truncated or simply malformed.
 */
function serializeAuditData(data: unknown): string | null {
	if (data === undefined || data === null) return null
	const json = JSON.stringify(data)
	// `JSON.stringify` answers undefined for a value that isn't representable (a bare
	// function, a symbol). Nothing here passes one, but the column would take the string
	// "undefined" if something ever did.
	if (json === undefined) return null
	if (json.length <= MAX_AUDIT_DATA_CHARS) return json
	return JSON.stringify({
		truncated: true,
		chars: json.length,
		preview: json.slice(0, MAX_AUDIT_DATA_CHARS),
	})
}
