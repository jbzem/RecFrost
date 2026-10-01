-- Restore the UNIQUE pair index on `relationship`.
--
-- Generated from packages/domain/src/relationships-db.ts (SCHEMA_DDL) — keep in sync.
-- Migration 0001 declared `idx_relationship` and 0030 counts on it staying ("it is the
-- pair constraint"), but the deployed table did not have it: an audit of sqlite_master
-- against every worker's migrations found it and the two `room_instance` unique indexes
-- (rooms 0022) missing, with every other declared index present. Every relationship
-- write is select-then-insert (`upsertPair`, `setRelationshipFlag`), so this index is the
-- only thing that stops a replayed or concurrent request from filing a pair twice —
-- which shows up as a doubled friend entry, with `findPair` reading whichever twin the
-- planner returns.
--
-- A UNIQUE index refuses to build over duplicates, so any are merged first: the oldest
-- row of each (requester_id, target_id) group survives, carrying the MAX of every field
-- across the group — for the flags that is an OR, and for `relationship_type` it is the
-- furthest-along state (3 Friend > 2 Received > 1 Sent > 0 None). Then the rest go. Both
-- statements are no-ops on a table with no duplicates.

UPDATE relationship SET
  relationship_type   = (SELECT MAX(r.relationship_type)   FROM relationship r WHERE r.requester_id = relationship.requester_id AND r.target_id = relationship.target_id),
  requester_favorited = (SELECT MAX(r.requester_favorited) FROM relationship r WHERE r.requester_id = relationship.requester_id AND r.target_id = relationship.target_id),
  requester_ignored   = (SELECT MAX(r.requester_ignored)   FROM relationship r WHERE r.requester_id = relationship.requester_id AND r.target_id = relationship.target_id),
  requester_muted     = (SELECT MAX(r.requester_muted)     FROM relationship r WHERE r.requester_id = relationship.requester_id AND r.target_id = relationship.target_id),
  target_favorited    = (SELECT MAX(r.target_favorited)    FROM relationship r WHERE r.requester_id = relationship.requester_id AND r.target_id = relationship.target_id),
  target_ignored      = (SELECT MAX(r.target_ignored)      FROM relationship r WHERE r.requester_id = relationship.requester_id AND r.target_id = relationship.target_id),
  target_muted        = (SELECT MAX(r.target_muted)        FROM relationship r WHERE r.requester_id = relationship.requester_id AND r.target_id = relationship.target_id)
 WHERE id IN (SELECT MIN(id) FROM relationship GROUP BY requester_id, target_id HAVING COUNT(*) > 1);

DELETE FROM relationship
 WHERE id NOT IN (SELECT MIN(id) FROM relationship GROUP BY requester_id, target_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_relationship ON relationship (requester_id, target_id);
