-- A never-reused id sequence for player events. Owned by the `api` worker; generated
-- from src/events-db.ts (SCHEMA_DDL) — keep in sync.
--
-- Event ids used to be `MAX(id) + 1` over the `event` table, which hands the NEWEST
-- event's id straight back out once it is deleted: delete an event, create another,
-- and the new one wears the old one's id — and inherits everything still filed under
-- it that lives outside the event's own rows (a `PlayerEventInvitation` message's
-- `player_event_id`, the client's own cache of the old event). An event id has to be
-- unique for all time, like the other ids here.
--
-- SQLite's AUTOINCREMENT is exactly that guarantee: the counter in `sqlite_sequence`
-- only ever goes up, whatever rows are deleted. `createEvent` draws an id by inserting
-- a row here and reading it back; the row itself is throwaway (it is deleted once
-- used — only the counter matters).
--
-- The seed row moves the counter past every event that already exists: inserting an
-- explicit id into an AUTOINCREMENT table raises the sequence to at least that id, so
-- the first draw after this migration is one past the current max, exactly what the
-- old query would have produced. On an empty table it inserts nothing.

CREATE TABLE IF NOT EXISTS event_id_seq (
  id INTEGER PRIMARY KEY AUTOINCREMENT
);
-- HAVING, not WHERE: an aggregate over an empty table still yields one (NULL) row, and
-- a NULL id would draw 1 from the counter, making the first real event 2.
INSERT INTO event_id_seq (id)
  SELECT MAX(id) FROM event HAVING MAX(id) IS NOT NULL;
