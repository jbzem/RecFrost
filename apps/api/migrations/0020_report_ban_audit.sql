-- Who handed a ban down, and when. A ban lives on the `report` row it rests on (see
-- 0009_report_ban.sql), which recorded the decision but not the deciding: there was no way
-- to tell which moderator set `banned`, and no way to tell WHEN they set it. Generated from
-- src/reports-db.ts (SCHEMA_DDL) — keep in sync.
--
-- `banned_at` is not bookkeeping. The client's block screen reads `TimeoutStartedAt` and
-- `Duration` as a PAIR — the block runs from the start for the duration — and
-- `moderationBlockDetails` had only the report's `created_at` to offer as that start. So a
-- ban applied to a month-old report told the banned player their block began a month ago,
-- and the duration (computed from there to `ban_expires`) came out a month short: a 7-day
-- ban on a 30-day-old report reads as already served. With this column the ban's own start
-- is recorded and `banBlockDetails` uses it, falling back to `created_at` so every row
-- written before this migration keeps behaving exactly as it did.
--
-- Both are NULL on an unbanned row, and are CLEARED when a ban is lifted — the report
-- itself survives, as it does for `banned`/`ban_expires`. So a non-null `banned_at` means
-- "a ban is or was in force from here", which is the same thing `banned = 1` means.
--
-- Neither column is indexed. `banned_by_player_id` is read per-row when a moderator looks
-- at a ban, never filtered on; the ban reads that exist go by player or by the ban flag
-- (idx_report_banned). Add an index alongside a query that needs one.

ALTER TABLE report ADD COLUMN banned_by_player_id INTEGER;
ALTER TABLE report ADD COLUMN banned_at TEXT;
