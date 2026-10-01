-- Cover the friend-list read (`getFriendIds` in @repo/domain, and the inlined copy in the
-- friends-filtered leaderboard). Owned by the `api` worker; generated from
-- packages/domain/src/relationships-db.ts (RELATIONSHIP_SCHEMA_DDL) — keep in sync.
--
-- The query is `relationship_type = ?2 AND (requester_id = ?1 OR target_id = ?1)`, which
-- SQLite already splits into one probe per side of the OR. But `relationship_type` was in
-- neither index and neither index carried the other side's id, so every row the player
-- appears in — of ANY type — cost an index read plus a table-row read, and the non-friends
-- were then discarded. Those rows accumulate: an unfriend keeps the row as type 0, ignoring
-- or muting a stranger inserts a type 0 row, pending requests are rows. And the query runs
-- on every matchmake and every disconnect (the presence push to friends), so D1 row reads
-- were roughly 2 x (all relationships) x (matchmakes).
--
-- These two indexes cover each half: seek to (player, Friend), read the other id off the
-- index, never touch the table. Reads become one per actual friend.
--
-- (target_id, relationship_type, requester_id) subsumes the old (target_id) index, so that
-- one goes. The unique (requester_id, target_id) index stays — it is the pair constraint
-- and what the single-pair lookups use.

CREATE INDEX IF NOT EXISTS idx_relationship_requester_type
  ON relationship (requester_id, relationship_type, target_id);
CREATE INDEX IF NOT EXISTS idx_relationship_target_type
  ON relationship (target_id, relationship_type, requester_id);
DROP INDEX IF EXISTS idx_relationship_target;
