-- Custom avatar items become a JSON blob per row, the layout every other entity table on this
-- database uses (`invention`, `event`, `room`, `account`, `club`): the client's `CustomAvatarItem`
-- record verbatim in `data`, with the fields the queries filter and sort on exposed as generated
-- (virtual) columns. Generated from src/custom-avatar-items-db.ts (SCHEMA_DDL) — keep in sync.
--
-- Why: the flat table (0015) had one NOT NULL column per field of the player-made shirt, and the
-- FIRST-PARTY items being imported are the same record with those four fields NULL
-- (`BaseAvatarItemId`, `BaseAvatarItemColor`, `DesignFilename`, `ThumbnailImageFilename` — a
-- studio-built item has no base item and no design PNG) plus fields the table had no home for:
-- `CurrentSaves` (one built Unity assetbundle per body type, which is how the client renders
-- them), `Tags`, `CustomBadgeMetadata`, `RankedEntityId`. Storing the record whole means the
-- import is the record as exported, and a field the source adds later is served without a
-- migration. `CurrentSaves` stays embedded rather than in a child table: the client reads a
-- save off its item and picks one by `BodyType`; nothing looks a save up by its bare id.
--
-- The generated columns keep the names the flat table had, so the indexes and every query
-- read the same. `name_lower`/`description_lower` back the store's search, which matches the
-- needle as a case-folded substring of either. Booleans come out of `json_extract` as 1/0
-- (see 0008), so `is_featured = 1` keeps working.
--
-- The existing player-made rows are carried across by rebuilding the DTO the old `toDto`
-- built from their columns — the same record the routes were already serving — with the
-- fields the flat table never had filled in as it served them (empty saves and tags, null
-- badge/ranking, `RankedEntityId` = the item id, as the official record carries it).

CREATE TABLE custom_avatar_item_new (
  data TEXT NOT NULL,
  custom_avatar_item_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.CustomAvatarItemId')) VIRTUAL,
  creator_account_id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.CreatorAccountId')) VIRTUAL,
  accessibility INTEGER GENERATED ALWAYS AS (json_extract(data, '$.Accessibility')) VIRTUAL,
  outfit_type INTEGER GENERATED ALWAYS AS (json_extract(data, '$.OutfitType')) VIRTUAL,
  price INTEGER GENERATED ALWAYS AS (json_extract(data, '$.Price')) VIRTUAL,
  is_featured INTEGER GENERATED ALWAYS AS (json_extract(data, '$.IsFeatured')) VIRTUAL,
  created_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.CreatedAt')) VIRTUAL,
  name_lower TEXT GENERATED ALWAYS AS (lower(coalesce(json_extract(data, '$.Name'), ''))) VIRTUAL,
  description_lower TEXT GENERATED ALWAYS AS (lower(coalesce(json_extract(data, '$.Description'), ''))) VIRTUAL
  );

INSERT INTO custom_avatar_item_new (data)
SELECT json_object(
  'CustomAvatarItemId', custom_avatar_item_id,
  'CreatorAccountId', creator_account_id,
  'Name', name,
  'Description', description,
  'Price', price,
  'Accessibility', accessibility,
  'ForceCannotPublish', json(iif(force_cannot_publish, 'true', 'false')),
  'IsFeatured', json(iif(is_featured, 'true', 'false')),
  'IsRecRoomApproved', json(iif(is_rec_room_approved, 'true', 'false')),
  'BaseAvatarItemId', base_avatar_item_id,
  'BaseAvatarItemColor', base_avatar_item_color,
  'DesignFilename', design_filename,
  'ThumbnailImageFilename', thumbnail_image_filename,
  'CreatedAt', created_at,
  'ModifiedAt', modified_at,
  'PreviewOrientation', preview_orientation,
  'OutfitType', outfit_type,
  'CurrentSaves', json('[]'),
  'Tags', json('[]'),
  'CustomBadgeMetadata', NULL,
  'RankedEntityId', custom_avatar_item_id,
  'RankingContext', NULL
) FROM custom_avatar_item;

DROP TABLE custom_avatar_item;
ALTER TABLE custom_avatar_item_new RENAME TO custom_avatar_item;

CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_avatar_item_id ON custom_avatar_item (custom_avatar_item_id);
CREATE INDEX IF NOT EXISTS idx_custom_avatar_item_creator ON custom_avatar_item (creator_account_id);
