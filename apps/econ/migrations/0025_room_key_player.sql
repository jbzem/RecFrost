-- Who HOLDS a room key — one row per (key, player).
--
-- Written by `POST /api/roomkeys/v1/awardbulk`, which awards the CALLER the keys its body
-- names. A key is held or it isn't — there is no quantity — so the pair is the primary key
-- and awarding a key a player already holds changes nothing (`awarded_at` keeps the first
-- award). `room_key_id` is `room_key.room_key_id`. Owned by the `econ` worker; generated
-- from src/room-key-db.ts (ROOM_KEY_SCHEMA_DDL) — keep in sync.
CREATE TABLE IF NOT EXISTS room_key_player (
  room_key_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  awarded_at TEXT NOT NULL,
  PRIMARY KEY (room_key_id, account_id)
  );

-- "This player's keys" — the primary key only serves lookups that lead with the key.
CREATE INDEX IF NOT EXISTS idx_room_key_player_account ON room_key_player (account_id);
