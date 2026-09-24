-- Expose the account's Rec Room Plus flag (`hasPlus` in the JSON blob) as an indexed
-- generated column, so "every Plus member" is an index walk rather than a scan of every
-- account's JSON. The reader is the operator's periodic token reload
-- (`just reload-plus`, packages/tools/src/cmd/admin.cmd.ts), which credits the
-- `balance` row of each Plus member in one statement.
--
-- The index is PARTIAL: it holds only the rows where the flag is set, so it is as small
-- as the subscriber list and never grows with the account table. A query must say
-- exactly `has_plus = 1` to use it. `json_extract` yields 1 for JSON true, 0 for false
-- and NULL when the key is absent, so neither a revoked nor a never-granted account is
-- in it. Kept in sync with SCHEMA_DDL in @repo/domain's accounts-db.ts (and its mirror
-- in apps/econ/src/avatar-db.ts).

ALTER TABLE account ADD COLUMN has_plus INTEGER GENERATED ALWAYS AS (json_extract(data, '$.hasPlus')) VIRTUAL;
CREATE INDEX IF NOT EXISTS idx_account_has_plus ON account (has_plus) WHERE has_plus = 1;
