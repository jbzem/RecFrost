-- Room bans that have ENDED, so `GET /rooms/{roomId}/bans/history` has a past to report.
--
-- Generated from packages/domain/src/rooms-db.ts (ROOM_SCHEMA_DDL) — keep in sync.
--
-- `room_ban` holds only the ban in force: one row per (room, player), DELETEd on unban and
-- overwritten on re-ban. Everything that asks "is this player banned" — `match` among them —
-- reads that table and is unchanged. This table is append-only and written at the moment a
-- ban stops being the live one:
--
--   * lifted by an unban   -> status 2 (Lifted),  ended_at = the unban, unbanned_by_account_id set
--   * lapsed, then cleared -> status 1 (Elapsed), ended_at = its expiry, unbanned_by_account_id NULL
--     (by an unban of the stale row, or by a new ban replacing it)
--
-- A ban still in force that is re-issued is AMENDED in place, not ended, so it writes nothing.
-- Nothing is backfilled: bans lifted before this migration were deleted and left no record.
CREATE TABLE IF NOT EXISTS room_ban_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL,
  banned_player_id INTEGER NOT NULL,
  ban_mask INTEGER NOT NULL DEFAULT 0,
  banned_by_account_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  reason TEXT,
  expires_at TEXT,
  status INTEGER NOT NULL,
  ended_at TEXT,
  unbanned_by_account_id INTEGER
  );
CREATE INDEX IF NOT EXISTS idx_room_ban_history_player
  ON room_ban_history (room_id, banned_player_id);
