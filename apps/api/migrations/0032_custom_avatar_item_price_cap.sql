-- Player-made custom shirts are capped at 1000 tokens (`MAX_PLAYER_ITEM_PRICE` in
-- src/custom-avatar-items-db.ts): the create and the edit now refuse a price above it, and
-- this lowers every existing player-made row that is already over it to exactly the cap.
--
-- Only PLAYER-MADE rows are touched, told apart by `BaseAvatarItemId`: a player-made shirt
-- is built on a base item, while a first-party item (imported from the official export,
-- Coach-authored) has it NULL and is priced from the storefront dump, where several sit
-- well above 1000. Those keep their prices.
--
-- `ModifiedAt` is bumped as the edit endpoint bumps it, since the record did change.
-- `price` is a generated column off `data`, so rewriting the JSON is the whole update.

UPDATE custom_avatar_item
SET data = json_set(data,
      '$.Price', 1000,
      '$.ModifiedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE json_extract(data, '$.BaseAvatarItemId') IS NOT NULL
  AND price > 1000;
