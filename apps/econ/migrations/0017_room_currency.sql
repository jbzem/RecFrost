-- Room currencies — a room's own money.
--
-- A creator mints one for their room ("MySpecialTokens"), hands it out for doing things in
-- there, and sells things for it: finish the obstacle course, earn 50 tokens, spend them on a
-- custom shirt at the shop by the door. Play money for one room, meaning nothing outside it.
--
-- A row here is the CURRENCY — its name, its coin art, how fast the room may hand it out.
-- What a player has actually earned is `room_balance` (migration 0019). Owned by the `econ`
-- worker; generated from src/room-currency-db.ts (ROOM_CURRENCY_SCHEMA_DDL) — keep in sync.
--
-- These are NOT balances and must never reach the `balance` table, which is keyed by
-- (account_id, currency_type) alone. That key cannot say WHICH room's currency a row is, so
-- one room's tokens would spend in every other room — see CurrencyType in src/balance-db.ts,
-- where RoomCurrency is left out of the spendable set for exactly this reason.
--
-- Every currency here is CurrencyType 300 (RoomCurrency) — that is what the type MEANS — and
-- is told apart from the others by its own `currency_id`, so the type is not a column.
--
-- `currency_id` is a GUID rather than an autoincrement: it is how the client names this
-- currency everywhere afterwards, and a room's currencies are minted independently of every
-- other room's, so an id that says nothing about ordering is the honest one.
--
-- `limit_amount`, not `limit` — LIMIT is a SQL keyword, and a column that has to be quoted at
-- every use is a column that will eventually not be. It holds the most of this currency the
-- room may award PER DAY: a faucet rate, not a cap on what a player may hold. Nothing enforces
-- it yet — no day's awards are tracked anywhere — so it is stored and served and otherwise
-- inert.
--
-- `shape` and `color` are the client's own indices into its coin art (the create body sends
-- `Shape=0&Color=19`); nothing interprets them, they are stored and served back. `image_name`
-- is separate and stays empty until a room can upload custom coin art — the client's model
-- carries both, so the column is here rather than in a later migration.
--
-- NOTE: `image_name` was NOT NULL DEFAULT '' here, and 0018 makes it nullable — the client
-- serves null, not an empty string, for a currency with no custom coin art. This file is left
-- as it shipped; the current shape of the table is 0017 + 0018.
CREATE TABLE IF NOT EXISTS room_currency (
  currency_id TEXT PRIMARY KEY,
  room_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  limit_amount INTEGER NOT NULL,
  shape INTEGER NOT NULL,
  color INTEGER NOT NULL,
  image_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL
  );

-- Every read is "this room's currencies" — the whole access pattern.
CREATE INDEX IF NOT EXISTS idx_room_currency_room ON room_currency (room_id);
