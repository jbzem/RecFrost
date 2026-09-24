-- Room consumables — the things a room sells.
--
-- The other half of a room's economy: `room_currency` (migration 0017) is the money a room
-- mints and hands out, and this is the shop that takes it back — a Health Potion for 25
-- tokens, a custom shirt for 500. A row here is the LISTING: its name, its picture, what it
-- costs and in which of the room's currencies. Written by
-- `PUT /api/roomconsumables/v1/roomConsumable` and read by
-- `GET /api/roomconsumables/v1/roomConsumable/room/{roomId}`. Owned by the `econ` worker;
-- generated from src/room-consumable-db.ts (ROOM_CONSUMABLE_SCHEMA_DDL) — keep in sync.
--
-- `room_consumable_id` is a GUID rather than an autoincrement, like a room currency's: it is
-- how the client names this listing afterwards, and a room's consumables are created
-- independently of every other room's.
--
-- The write body's `PriceAndCurrency` object is COLLAPSED here into `price` and
-- `purchase_currency_id`. It is one price in one currency, and a nested object would buy
-- nothing but a JSON blob to query through. Note the client READS them flat, so the write
-- shape and the read shape genuinely differ — do not unify them.
--
-- `purchase_currency_id` points at a `room_currency` and is nullable (`Guid?` in the client's
-- model), for a listing that names no currency. Nothing resolves or validates it yet: a
-- consumable priced in a currency that has since been deleted still lists, at a price nobody
-- can pay. `image_name` is nullable for the same reason — a listing with no picture. `price`
-- is not: a listing always has one, even if it is zero.
--
-- Nothing BUYS a consumable yet. There is no purchase endpoint, so
-- `maximum_count_per_purchase` is stored and served and read by nothing.
CREATE TABLE IF NOT EXISTS room_consumable (
  room_consumable_id TEXT PRIMARY KEY,
  room_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  image_name TEXT,
  price INTEGER NOT NULL,
  purchase_currency_id TEXT,
  modified_at TEXT NOT NULL,
  maximum_count_per_purchase INTEGER NOT NULL DEFAULT 0
  );

-- Every read is "this room's shop" — the whole access pattern.
CREATE INDEX IF NOT EXISTS idx_room_consumable_room ON room_consumable (room_id);
