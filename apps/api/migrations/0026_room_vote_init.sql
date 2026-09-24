-- Marks the ballot that CALLED a vote-to-kick. Generated from src/votes-db.ts (SCHEMA_DDL) —
-- keep in sync.
--
-- The client posts the call and every answer to the same endpoint with the same body, so
-- nothing on the wire says which ballot started a vote. `init` is 1 on the first ballot cast
-- against a player in a session while no vote on them is open (VOTE_WINDOW_MS), 0 on every
-- answer. Two things read it:
--   - the tally counts only ballots from the open vote's `init` row on, so an expired vote's
--     yes ballots cannot carry the next one;
--   - the caller throttle: a player who called a vote within VOTE_CALL_COOLDOWN_MS may not
--     call another (`idx_room_vote_caller`). Answering is never throttled.
--
-- Backfill: each (session, player)'s first ballot is taken as its call. Those sessions are
-- over, so this only keeps the caller history honest.

ALTER TABLE room_vote ADD COLUMN init INTEGER NOT NULL DEFAULT 0;

UPDATE room_vote SET init = 1
WHERE id IN (SELECT MIN(id) FROM room_vote GROUP BY game_session_id, player_id);

CREATE INDEX IF NOT EXISTS idx_room_vote_caller ON room_vote (voter_id, voted_at) WHERE init = 1;
