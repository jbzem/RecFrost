-- Inventions are capped at 1000 tokens (`MAX_INVENTION_PRICE` in src/inventions-db.ts): the
-- three writes a creator has (`v3/publish`, `v4/publish`, `v1/updateprice`) now refuse a
-- price above it, and this lowers every existing row already over it to exactly the cap.
-- Drafts included — a draft's price is what its next publish would list it at.
--
-- `ModifiedAt` is left alone, as `v1/updateprice` leaves it: a reprice is not an edit of
-- the invention. `price` is not a generated column here, so the JSON is the whole update.

UPDATE invention
SET data = json_set(data, '$.Price', 1000)
WHERE json_extract(data, '$.Price') > 1000;
