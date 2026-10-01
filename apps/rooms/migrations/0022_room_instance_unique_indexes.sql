-- Restore the two UNIQUE indexes on `room_instance`.
--
-- Generated from packages/domain/src/room-instance-db.ts (ROOM_INSTANCE_SCHEMA_DDL) —
-- keep in sync. The DDL and migration 0004 have always declared them, but the deployed
-- table carried only the non-unique `idx_room_instance_room_id`: the two `CREATE UNIQUE
-- INDEX` statements never took, so nothing has enforced uniqueness on `id` or
-- `photon_room_id` in production. Two rows sharing one `photon_room_id` were found —
-- the signature of a replayed INSERT (same blob written twice), which the index would
-- have refused. Without the `id` index the `MAX(id) + 1` allocation in
-- createRoomInstance can also hand two concurrent matchmakes the same id, which the
-- index would have failed loudly instead of silently minting two instances.
--
-- A UNIQUE index refuses to build over duplicates, so they're removed first. Instances
-- are live sessions, not records: of each duplicate set the earliest row (lowest rowid)
-- is kept and the rest dropped. A replayed insert's twins are identical, so nothing is
-- lost; presence rows point at instances by `id`, which the survivor still carries.
-- Dedupe by `id` first so a row that is a duplicate on both counts is only counted once.

DELETE FROM room_instance
 WHERE rowid NOT IN (SELECT MIN(rowid) FROM room_instance GROUP BY id);

DELETE FROM room_instance
 WHERE rowid NOT IN (SELECT MIN(rowid) FROM room_instance GROUP BY photon_room_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_room_instance_id ON room_instance (id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_instance_photon_room_id ON room_instance (photon_room_id);
