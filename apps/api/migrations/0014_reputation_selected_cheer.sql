-- No-op preserver. `is_cheerful` and `selected_cheer` were meant to be added here,
-- but 0013 now creates them inline (folded — fresh databases get the full table from
-- that file, matching `reputation-db.ts` SCHEMA_DDL), and databases created from the
-- pre-fold schema already carry both columns — a real ALTER here would fail on them
-- with "duplicate column name" and halt the whole migration chain. So this file
-- intentionally changes nothing: it exists only to keep the numbering stable (later
-- files must NOT be renumbered — developer databases already recorded them) and to
-- record that this step was considered and reconciled.
--
-- The UPDATE below is the deliberate no-op that keeps the file a valid migration on
-- every database: it matches zero rows everywhere and alters nothing. Do NOT replace
-- it with the original ALTER TABLEs.

UPDATE reputation SET account_id = account_id WHERE 0;
