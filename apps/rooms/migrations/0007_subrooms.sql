-- Subrooms as first-class entities. In the original game a subroom has its own
-- globally-unique, autoincrementing `SubRoomId` (minted from a single sequence, not
-- per-room), so they can't live inside the room JSON blob — cloning/dorm creation
-- would otherwise reuse ids and collide across rooms. This moves them into their own
-- `subroom` table keyed by an AUTOINCREMENT `sub_room_id`, backfills from each room's
-- embedded `SubRooms`, and drops `SubRooms` from the room blob. Rooms re-embed their
-- `SubRooms` array on read. Generated from packages/domain/src/rooms-db.ts
-- (SUBROOM_SCHEMA_DDL) — keep in sync.

CREATE TABLE IF NOT EXISTS subroom (
  sub_room_id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL,
  data TEXT NOT NULL
  );
CREATE INDEX IF NOT EXISTS idx_subroom_room ON subroom (room_id);

-- Backfill. The live blob already contains collisions (the bug this migration fixes:
-- every dorm carries SubRoomId 1, clones reuse per-room ids), so we can't preserve all
-- ids. We keep the FIRST occurrence of each distinct SubRoomId at its original id (so the
-- seeded rooms keep their canonical ids) and mint fresh globally-unique ids for the rest.

-- 1) First occurrence of each non-null SubRoomId keeps its id (lowest room_id wins).
INSERT INTO subroom (sub_room_id, room_id, data)
  SELECT sid, room_id, data FROM (
    SELECT
      CAST(json_extract(je.value, '$.SubRoomId') AS INTEGER) AS sid,
      r.room_id AS room_id,
      je.value AS data,
      ROW_NUMBER() OVER (
        PARTITION BY json_extract(je.value, '$.SubRoomId')
        ORDER BY r.room_id
      ) AS rn
    FROM room r, json_each(r.data, '$.SubRooms') je
  )
  WHERE rn = 1 AND sid IS NOT NULL;

-- 2) Everything else (the duplicates, and any null ids) gets a fresh autoincrement id.
--    Inserting the explicit ids above advanced sqlite_sequence, so these continue past
--    the highest kept id and never collide.
INSERT INTO subroom (room_id, data)
  SELECT room_id, data FROM (
    SELECT
      CAST(json_extract(je.value, '$.SubRoomId') AS INTEGER) AS sid,
      r.room_id AS room_id,
      je.value AS data,
      ROW_NUMBER() OVER (
        PARTITION BY json_extract(je.value, '$.SubRoomId')
        ORDER BY r.room_id
      ) AS rn
    FROM room r, json_each(r.data, '$.SubRooms') je
  )
  WHERE NOT (rn = 1 AND sid IS NOT NULL);

-- Single source of truth: drop the now-migrated SubRooms array from the room blob.
UPDATE room SET data = json_remove(data, '$.SubRooms');
