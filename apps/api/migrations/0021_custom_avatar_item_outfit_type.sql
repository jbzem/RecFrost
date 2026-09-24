-- File every custom avatar item under OutfitType 105 (`RecRoom.Avatars.OutfitType.CustomShirt`).
-- Creation left `outfit_type` at the column's default of 0 (Hat), and the store's
-- user-generated-content tab searches `GET /api/customAvatarItems/v1/search?outfitTypes=105`
-- ALONE, so the tab sat empty over a full catalog. The custom shirt is the one kind of custom avatar item the
-- client can make, so every row written before this migration is one. Creation now writes
-- 105 itself (src/custom-avatar-items-db.ts, OUTFIT_TYPE_CUSTOM_SHIRT).
UPDATE custom_avatar_item SET outfit_type = 105 WHERE outfit_type = 0;
