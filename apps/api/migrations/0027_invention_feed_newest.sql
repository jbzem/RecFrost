-- Index the browse/search feed (`searchInventions`) in the order it pages: newest first.
-- Without it every page — however small — parsed the JSON of every published invention,
-- sorted the lot in a temp B-tree and threw all but one page away. With it the query walks
-- this index in order and stops after OFFSET + LIMIT rows.
--
-- PARTIAL, over exactly the rows `VISIBLE_IN_FEEDS` admits, so it holds only what a feed can
-- show. SQLite uses a partial index only when the query's WHERE contains each of these terms
-- as written, so this WHERE must track `VISIBLE_IN_FEEDS` in src/inventions-db.ts term for
-- term — change one and the index silently stops being used. The key is the same
-- `json_extract` expression the query orders by, which is what lets it replace the sort.
-- Generated from src/inventions-db.ts (SCHEMA_DDL) — keep in sync.

CREATE INDEX IF NOT EXISTS idx_invention_feed_newest
  ON invention (json_extract(data, '$.CreatedAt') DESC, id DESC)
  WHERE is_published = 1
    AND hide_from_player = 0
    AND COALESCE(json_extract(data, '$.Accessibility'), 0) <> 2;
