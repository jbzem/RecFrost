-- Vote-to-kick ballots: one row per vote cast, appended, never updated.
--
-- Generated from apps/api/src/votes-db.ts (SCHEMA_DDL) — keep in sync.
--
-- `response` is 1 for yes (kick them) and 0 for no. A player who votes twice leaves two
-- rows: the tally counts DISTINCT voters and reads only each one's latest ballot, so
-- re-posting a vote cannot carry one, and a voter may change their mind.
--
-- Rows are keyed to `game_session_id` (a `room_instance` id) and outlive the session.
-- Nothing prunes them; instance ids are not reused, so an old session's ballots can never
-- be counted into a new one's.
CREATE TABLE IF NOT EXISTS room_vote (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_session_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  response INTEGER NOT NULL,
  voter_id INTEGER NOT NULL,
  voted_at TEXT NOT NULL
  );
CREATE INDEX IF NOT EXISTS idx_room_vote_subject ON room_vote (game_session_id, player_id);
