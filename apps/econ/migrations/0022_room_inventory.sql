-- What players own of a room's consumables — the other side of a room's shop. `room_consumable`
-- (migration 0021) is what a room sells; this is who has one. Written by
-- `POST /api/roomconsumables/v1/roomConsumable/awardBulk`. Owned by the `econ` worker;
-- generated from src/room-consumable-db.ts (ROOM_INVENTORY_SCHEMA_DDL) — keep in sync.
--
-- Keyed by CONSUMABLE, not by room: `room_consumable` already says which room a listing
-- belongs to, and repeating it here would be a second place for that to be wrong. It is the
-- same reasoning as `room_balance` (0019), which holds a currency id rather than a room id.
--
-- A missing row is a quantity of zero. Nothing is inserted until a player is first given one,
-- so a room's shop costs a row per player who actually owns something rather than one per
-- player who has looked at it.
--
-- `consumable_id` is not a foreign key — nothing in this database is — but the award route
-- checks the listing exists before writing: an inventory row naming nothing would be a thing a
-- player owns that cannot be described.
CREATE TABLE IF NOT EXISTS room_inventory (
  player_id INTEGER NOT NULL,
  consumable_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, consumable_id)
  );

-- "What does this player own?" is the read the client makes on entering a room, so the player
-- half of the key earns its own index for the lookups that start there.
CREATE INDEX IF NOT EXISTS idx_room_inventory_player ON room_inventory (player_id);
