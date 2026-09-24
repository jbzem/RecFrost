-- Make `room_currency.image_name` nullable, and turn the empty strings already stored into
-- nulls. Owned by the `econ` worker; 0017 created the table with `image_name TEXT NOT NULL
-- DEFAULT ''`. Generated from src/room-currency-db.ts (ROOM_CURRENCY_SCHEMA_DDL, which mirrors
-- the table as it stands AFTER this migration) — keep in sync.
--
-- The client's own model has `ImageName` as a nullable string and serves NULL for a currency
-- with no custom coin art; an empty string is a different value to its decoder, so a currency
-- created before this read back as having art named "". Nothing can upload coin art yet, so
-- every row is affected and every one of them should be null.
--
-- A rebuild rather than an ALTER: SQLite cannot drop a NOT NULL constraint in place. This is
-- the standard four-step swap — build the new shape, copy across, drop the old, rename — and
-- the index goes with the dropped table, so it is recreated at the end rather than left to be
-- noticed later by a slow query. `NULLIF(image_name, '')` is the conversion: it maps '' to
-- NULL and leaves a real name alone, so a row that somehow already carries art keeps it.
--
-- Safe to re-run in spirit but not in fact — it is a migration, applied once, and the rename
-- would fail on a second pass because `room_currency_new` no longer exists.
CREATE TABLE room_currency_new (
  currency_id TEXT PRIMARY KEY,
  room_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  limit_amount INTEGER NOT NULL,
  shape INTEGER NOT NULL,
  color INTEGER NOT NULL,
  image_name TEXT,
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL
  );

INSERT INTO room_currency_new (
  currency_id, room_id, name, description, limit_amount, shape, color, image_name, created_at, modified_at
  )
SELECT
  currency_id, room_id, name, description, limit_amount, shape, color, NULLIF(image_name, ''), created_at, modified_at
FROM room_currency;

DROP TABLE room_currency;

ALTER TABLE room_currency_new RENAME TO room_currency;

-- Recreated because dropping the old table took its index with it. Same index 0017 defined:
-- every read is "this room's currencies".
CREATE INDEX IF NOT EXISTS idx_room_currency_room ON room_currency (room_id);
