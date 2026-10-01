-- Index `interaction` by room, covering the two counters.
--
-- Generated from packages/domain/src/rooms-db.ts (ROOM_SCHEMA_DDL) — keep in sync.
--
-- The table's primary key is (player_id, room_id), which serves the per-player reads
-- (toggle a cheer, list my favorites) but is useless to the per-ROOM aggregate that every
-- room read runs (`getRoomStats`: `SELECT room_id, SUM(cheered), SUM(favorited) … WHERE
-- room_id IN (…) GROUP BY room_id`). Without this index that query scanned the whole
-- table on every call — 1.29B rows read over five days. With it, each room id is one
-- index range, and the two counters are in the index so the table itself is never read.

CREATE INDEX IF NOT EXISTS idx_interaction_room ON interaction (room_id, cheered, favorited);
