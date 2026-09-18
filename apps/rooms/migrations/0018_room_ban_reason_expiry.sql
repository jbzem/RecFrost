-- A room ban can now carry a reason and lapse on its own.
--
-- Generated from packages/domain/src/rooms-db.ts (ROOM_SCHEMA_DDL) — keep in sync.
--
-- `reason` is the issuer's free text, NULL when none was given. `expires_at` is ISO-8601 UTC
-- (the same format `created_at` is written in, so the two compare as strings), and NULL is a
-- permanent ban — which is what every row written before this migration is, so no backfill.
--
-- A lapsed row is not deleted when it lapses: nothing runs at that moment. Every read that
-- asks whether a player is banned filters on `expires_at IS NULL OR expires_at > now` instead,
-- and the next ban or unban of that player overwrites or removes the stale row.
ALTER TABLE room_ban ADD COLUMN reason TEXT;
ALTER TABLE room_ban ADD COLUMN expires_at TEXT;
