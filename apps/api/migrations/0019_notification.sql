-- Stored notifications — the delayed half of a WebSocket push, served back by
-- `GET /api/messages/v2/get` when a player logs in. Owned by the `api` worker; also written
-- by `rooms` (a room-role invite) and `notify` (a coach message to one player), which push
-- the matching `MessageReceived` frame. Generated from
-- packages/domain/src/notifications-db.ts (NOTIFICATION_SCHEMA_DDL) — keep in sync.
--
-- Until this table existed the inbox endpoint answered an empty list unconditionally and the
-- hub's queued frame was the whole of a notification sent to an offline player. That queue is
-- best-effort by construction — dropped once sent rather than acked, bounded per player, and
-- skipped whenever the hub believes it delivered (a socket the client has abandoned still
-- counts) — so a push could be lost with nothing left to show for it.
--
-- `notification_id` is what ties the two halves together: it is the `Id` on the frame that
-- delivers the notification, so the client can match what it was pushed to what it later
-- reads from the inbox, and `POST /api/messages/v3/delete` has an id to match. Senders write
-- the row FIRST and build the frame from it. AUTOINCREMENT rather than a bare rowid alias
-- because the id is handed to the client and deleting a row frees its rowid — a reused id
-- would point a client's stale entry at somebody else's notification.
--
-- Named `notification` and not `message`: the `chat` worker already owns a `message` table on
-- this same shared database (its thread posts). `CREATE TABLE IF NOT EXISTS` against a name
-- already taken does nothing and says nothing, so the first draft of this migration silently
-- adopted chat's table and failed only on the index below, over a column it doesn't have.
--
-- Deliberately NOT stored, because none of it is worth reading later: the coach BROADCAST (a
-- maintenance notice to everyone online at once — a row per player, thousands per send), the
-- vote-to-kick prompt (about a session that has since ended), and a cheer (its durable record
-- is the `reputation` counters; the Message is the part that plays in front of the room).
--
-- `data` is nullable because a Message's `Data` is: the types carrying no payload of their
-- own send null, distinct from the empty string a DM sends. Where set it is always a STRING,
-- whatever it means to that type (a room-role invite puts the offered role tier in it).
CREATE TABLE IF NOT EXISTS notification (
  notification_id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_player_id INTEGER NOT NULL,
  to_player_id INTEGER NOT NULL,
  type INTEGER NOT NULL,
  data TEXT,
  room_id INTEGER,
  player_event_id INTEGER,
  sent_time TEXT NOT NULL
  );

-- The inbox read and the newest-wins trim are both "this player's notifications, newest
-- first", which is the whole access pattern.
CREATE INDEX IF NOT EXISTS idx_notification_recipient ON notification (to_player_id, notification_id DESC);
