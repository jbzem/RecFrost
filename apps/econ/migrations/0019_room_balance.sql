-- How much of a room's own money each player has earned — the other half of room currencies
-- (the currencies themselves are `room_currency`, migration 0017). Written by
-- `POST /api/roomcurrencies/v1/awardCurrency/bulk`, which is how a room pays a player for
-- finishing its obstacle course. Owned by the `econ` worker; generated from
-- src/room-currency-db.ts (ROOM_BALANCE_SCHEMA_DDL) — keep in sync.
--
-- Keyed by CURRENCY, not by currency type, and that difference is the whole point: the
-- account-scoped `balance` table's (account_id, currency_type) key cannot say WHICH room's
-- currency a row is, so one room's tokens would spend in every other room. Room currencies
-- are left out of that table for exactly this reason (see CurrencyType in src/balance-db.ts)
-- and live here instead, keyed by the `currency_id` that names one room's currency uniquely.
--
-- The room is not a column: `room_currency` already says which room a currency belongs to,
-- and repeating it here would be a second place for that to be wrong.
--
-- A missing row is a balance of zero. Nothing is inserted until a player is first awarded
-- some, so a room's currency costs a row per player who has actually earned it rather than
-- one per player who has walked in.
CREATE TABLE IF NOT EXISTS room_balance (
  currency_id TEXT NOT NULL,
  player_id INTEGER NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (currency_id, player_id)
  );

-- "What does this player hold across the room?" walks the room's currencies, so the reverse
-- lookup earns its own index rather than a scan of every holder of every currency.
CREATE INDEX IF NOT EXISTS idx_room_balance_player ON room_balance (player_id);
