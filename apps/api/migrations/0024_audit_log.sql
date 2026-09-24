-- The audit log — one row per privileged action a staff account took. Owned by the `api`
-- worker; WRITTEN by `notify`, which records every call to its admin-gated `/internal/*`
-- endpoints here. Generated from packages/domain/src/audit-db.ts (AUDIT_LOG_SCHEMA_DDL) —
-- keep in sync.
--
-- This is not the worker log. `logger.info` lines are for reading during an incident: they
-- are sampled, they expire, and nothing can be asked of them later. The actions this table
-- exists for leave no other trace on the database at all — a maintenance broadcast is a
-- WebSocket frame and then nothing, and a coach message to every online player is
-- deliberately not stored (see 0019_notification.sql) — so without a row here there is no
-- answer at all to "who sent that, and when", a question that tends to arrive weeks later.
--
-- `player_id` is the ACTOR: the staff account that made the call, never whoever it was
-- aimed at. A target, where there is one, lives inside `data` with the rest of what was
-- asked for. The broadcasts have no target at all, so a column for one would be null on
-- half the table and could not be the thing every row is filed under.
--
-- `data` is JSON as TEXT, and deliberately unstructured: each action records what it was
-- asked to do, and those shapes have nothing in common beyond being worth keeping. It is
-- nullable because an action whose whole content is its name has nothing to put there, and
-- null says that where `{}` would only look like a payload that went missing. Capped at
-- 4096 characters by the writer, since a request body's size is the caller's to choose;
-- over that the row keeps the head of the JSON and says `truncated`.
--
-- `audit_log_id` is a plain rowid alias, not AUTOINCREMENT: the id never leaves the server
-- (unlike `notification`'s, which is handed to the client) and nothing deletes from this
-- table, so there are no freed rowids to be reused. Reads order by it rather than by
-- `date`, which ties when two actions land in the same millisecond.
CREATE TABLE IF NOT EXISTS audit_log (
  audit_log_id INTEGER PRIMARY KEY,
  player_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  data TEXT,
  date TEXT NOT NULL
  );

-- The two ways anyone asks this table anything: everything one staffer did, and every time
-- a given action was taken. Both newest-first, which is the order an audit trail is read in.
CREATE INDEX IF NOT EXISTS idx_audit_log_player ON audit_log (player_id, audit_log_id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action, audit_log_id DESC);
