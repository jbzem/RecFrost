-- Owned CUSTOM avatar items, owned by the `econ` worker. One row per (account, item): the
-- custom avatar items a player has bought through `POST /api/items/bulkpurchase` (a line whose
-- `ItemPurchaseMethodId` is a `Guid`, the item's `CustomAvatarItemId`) and read back by
-- `GET /econ/customAvatarItems/v1/owned`, which serves each owned item's full record.
--
-- Only the id is stored: the item itself lives in `custom_avatar_item`, whose schema the `api`
-- worker owns (apps/api/migrations/0022_custom_avatar_item_json.sql) on this same database,
-- and copying its record here would leave two rows to keep in step — the same split as
-- `inventory_invention` (0008). Ownership is boolean, so the pair is the primary key and a
-- second purchase is refused rather than charged twice. The creator is NOT listed here: they
-- own their item through `CreatorAccountId`, and the buy path refuses to sell them their own.
--
-- Kept in sync with INVENTORY_CUSTOM_SCHEMA_DDL in src/inventory-custom-db.ts.

CREATE TABLE IF NOT EXISTS inventory_custom (
  account_id INTEGER NOT NULL,
  custom_avatar_item_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (account_id, custom_avatar_item_id)
  );
