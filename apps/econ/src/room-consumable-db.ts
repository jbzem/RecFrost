/**
 * Room consumables — the things a room sells.
 *
 * The other half of a room's economy: `room-currency-db.ts` mints the money ("MySpecialTokens")
 * and hands it out, and this is the shop that takes it back — a Health Potion for 25 tokens,
 * a custom shirt for 500. A consumable is the LISTING: its name, its picture, what it costs
 * and in which of the room's currencies.
 *
 * The endpoints:
 *  - `PUT /api/roomconsumables/v1/roomConsumable` creates one, or edits it when the body
 *    names an existing `RoomConsumableId`
 *  - `GET /api/roomconsumables/v1/roomConsumable/room/{roomId}` lists a room's
 *  - `POST /api/roomconsumables/v1/roomConsumable/awardBulk` gives one to a player
 *
 * `PurchaseCurrencyId` is a `room_currency`, so a room prices its goods in its own money. It
 * is nullable — `Guid?` in the client's model — for a listing that names no currency, and
 * nothing here resolves or validates it yet: a consumable priced in a currency that has since
 * been deleted still lists, at a price nobody can pay.
 *
 * Nothing BUYS one yet. There is no purchase endpoint, so `MaximumCountPerPurchase` is stored
 * and served and read by nothing.
 *
 * This worker (`econ`) owns the tables and their migrations — see apps/econ/migrations/,
 * 0021 (the listings) and 0022 (what players own of them).
 */

/** Schema DDL (mirror of migrations 0021_room_consumable.sql) — also builds the table in tests. */
export const ROOM_CONSUMABLE_SCHEMA_DDL: string[] = [
	// `room_consumable_id` is a GUID rather than an autoincrement, like a room currency's: it
	// is how the client names this listing afterwards, and a room's consumables are created
	// independently of every other room's.
	//
	// `image_name` and `purchase_currency_id` are nullable because the client's model has them
	// so — a listing with no picture, or none priced in a room currency. `price` is not: a
	// listing always has a price, even if it is zero.
	//
	// The body's `PriceAndCurrency` object is COLLAPSED here into `price` and
	// `purchase_currency_id`. It is one price in one currency, and a nested object would buy
	// nothing but a JSON blob to query through.
	`CREATE TABLE IF NOT EXISTS room_consumable (
		room_consumable_id TEXT PRIMARY KEY,
		room_id INTEGER NOT NULL,
		name TEXT NOT NULL,
		description TEXT NOT NULL,
		image_name TEXT,
		price INTEGER NOT NULL,
		purchase_currency_id TEXT,
		modified_at TEXT NOT NULL,
		maximum_count_per_purchase INTEGER NOT NULL DEFAULT 0
	)`,
	// Every read is "this room's shop" — the whole access pattern.
	`CREATE INDEX IF NOT EXISTS idx_room_consumable_room ON room_consumable (room_id)`,
]

/**
 * One room consumable as the client reads it — its own model, member for member and in its
 * order, taken from the client's field layout.
 *
 * Note `Price`/`PurchaseCurrencyId` here against the `PriceAndCurrency` object the write
 * takes: the client sends them nested and reads them flat, so the two shapes are not the same
 * and must not be unified.
 */
export interface RoomConsumable {
	RoomConsumableId: string
	RoomId: number
	Name: string
	Description: string
	/** Null for a listing with no picture. */
	ImageName: string | null
	Price: number
	/** A `room_currency` id — the room's own money. Nullable in the client's model. */
	PurchaseCurrencyId: string | null
	/** ISO-8601 UTC. */
	ModifiedAt: string
	/** How many may be bought at once. Stored and served; nothing buys a consumable yet. */
	MaximumCountPerPurchase: number
}

/** What the write supplies. The id is minted on a create and kept on an edit. */
export interface NewRoomConsumable {
	RoomId: number
	Name: string
	Description: string
	ImageName: string | null
	Price: number
	PurchaseCurrencyId: string | null
	MaximumCountPerPurchase: number
}

interface RoomConsumableRow {
	room_consumable_id: string
	room_id: number
	name: string
	description: string
	image_name: string | null
	price: number
	purchase_currency_id: string | null
	modified_at: string
	maximum_count_per_purchase: number
}

const SELECT_COLUMNS = `room_consumable_id, room_id, name, description, image_name, price, purchase_currency_id, modified_at, maximum_count_per_purchase`

const toRoomConsumable = (row: RoomConsumableRow): RoomConsumable => ({
	RoomConsumableId: row.room_consumable_id,
	RoomId: row.room_id,
	Name: row.name,
	Description: row.description,
	ImageName: row.image_name,
	Price: row.price,
	PurchaseCurrencyId: row.purchase_currency_id,
	ModifiedAt: row.modified_at,
	MaximumCountPerPurchase: row.maximum_count_per_purchase,
})

/** One consumable by its id, or null when there is no such row. */
export async function getRoomConsumable(
	db: D1Database,
	roomConsumableId: string
): Promise<RoomConsumable | null> {
	const row = await db
		.prepare(`SELECT ${SELECT_COLUMNS} FROM room_consumable WHERE room_consumable_id = ?1`)
		.bind(roomConsumableId)
		.first<RoomConsumableRow>()

	return row ? toRoomConsumable(row) : null
}

/**
 * Create a listing, or replace one when `roomConsumableId` names an existing row.
 *
 * One function because the client uses one call for both — a `PUT` whose `RoomConsumableId`
 * is null on a create and the listing's id on an edit — and because the two write the same
 * columns. An edit REPLACES rather than merges: the client sends the whole form back, so an
 * absent field is a cleared field, not an unmentioned one. (That is the opposite of the
 * currency edit, whose body is genuinely partial.)
 *
 * `ModifiedAt` is set on both. `RoomId` is written from the caller's already-checked value,
 * so an edit cannot move a listing into another room — the room comes off the STORED listing
 * on an edit, never the body.
 */
export async function upsertRoomConsumable(
	db: D1Database,
	roomConsumableId: string | null,
	consumable: NewRoomConsumable
): Promise<RoomConsumable> {
	const row: RoomConsumableRow = {
		room_consumable_id: roomConsumableId ?? crypto.randomUUID(),
		room_id: consumable.RoomId,
		name: consumable.Name,
		description: consumable.Description,
		image_name: consumable.ImageName,
		price: consumable.Price,
		purchase_currency_id: consumable.PurchaseCurrencyId,
		modified_at: new Date().toISOString(),
		maximum_count_per_purchase: consumable.MaximumCountPerPurchase,
	}

	await db
		.prepare(
			`INSERT INTO room_consumable (${SELECT_COLUMNS})
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
			 ON CONFLICT (room_consumable_id) DO UPDATE SET
			   name = ?3, description = ?4, image_name = ?5, price = ?6,
			   purchase_currency_id = ?7, modified_at = ?8, maximum_count_per_purchase = ?9`
		)
		.bind(
			row.room_consumable_id,
			row.room_id,
			row.name,
			row.description,
			row.image_name,
			row.price,
			row.purchase_currency_id,
			row.modified_at,
			row.maximum_count_per_purchase
		)
		.run()

	return toRoomConsumable(row)
}

/**
 * A room's shop, oldest first — the order the owner built it up in, which is the order they
 * expect to see it in. A room that sells nothing is an empty list.
 */
export async function getRoomConsumables(
	db: D1Database,
	roomId: number
): Promise<RoomConsumable[]> {
	const { results } = await db
		.prepare(
			`SELECT ${SELECT_COLUMNS} FROM room_consumable
			 WHERE room_id = ?1 ORDER BY modified_at, room_consumable_id`
		)
		.bind(roomId)
		.all<RoomConsumableRow>()

	return results.map(toRoomConsumable)
}

/**
 * What a player owns of a room's consumables — the shop's other side, filled by
 * `POST /api/roomconsumables/v1/roomConsumable/awardBulk`.
 *
 * Keyed by CONSUMABLE, not by room: `room_consumable` already says which room a listing
 * belongs to, and repeating it here would be a second place for that to be wrong. A missing
 * row is a quantity of zero — nothing is inserted until a player is first given one, so a
 * room's shop costs a row per player who actually owns something rather than one per player
 * who has looked at it.
 *
 * `consumable_id` is not a foreign key, but the award route checks the listing exists before
 * writing: an inventory row naming nothing would be a thing a player owns that cannot be
 * described.
 */
export const ROOM_INVENTORY_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS room_inventory (
		player_id INTEGER NOT NULL,
		consumable_id TEXT NOT NULL,
		quantity INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (player_id, consumable_id)
	)`,
	// "What does this player own?" is the read the client makes on entering a room, so the
	// player half of the key earns its own index for the lookups that start there.
	`CREATE INDEX IF NOT EXISTS idx_room_inventory_player ON room_inventory (player_id)`,
]

/** What a player owns of one consumable. */
export interface RoomInventoryItem {
	PlayerId: number
	ConsumableId: string
	Quantity: number
}

/**
 * Give a player some of a consumable, returning what they own afterwards.
 *
 * Floored at zero in the statement itself, so a negative `quantity` deducts without a
 * deduction and a concurrent award racing it below zero. Returns the RESULTING total, never
 * the change — the same rule the currency balances follow, and for the same reason: every
 * surface that shows an inventory shows the total.
 *
 * Read BACK rather than taken from a `RETURNING`, for the reason {@link awardRoomCurrency}
 * spells out: an empty RETURNING is indistinguishable from an award that changed nothing, so
 * a write that didn't land would report a plausible-looking but wrong total. All three
 * statements are one `batch`, which D1 runs as a transaction.
 */
export async function awardRoomConsumable(
	db: D1Database,
	playerId: number,
	consumableId: string,
	quantity: number
): Promise<number> {
	const read = db.prepare(
		'SELECT quantity FROM room_inventory WHERE player_id = ?1 AND consumable_id = ?2'
	)
	const [, , after] = await db.batch<{ quantity: number }>([
		read.bind(playerId, consumableId),
		db
			.prepare(
				`INSERT INTO room_inventory (player_id, consumable_id, quantity)
				 VALUES (?1, ?2, MAX(0, ?3))
				 ON CONFLICT (player_id, consumable_id)
				   DO UPDATE SET quantity = MAX(0, room_inventory.quantity + ?3)`
			)
			.bind(playerId, consumableId, quantity),
		read.bind(playerId, consumableId),
	])

	// No row means a quantity of zero — nothing is inserted until a player is first given one.
	return after.results[0]?.quantity ?? 0
}

/** Everything a player owns of one room's consumables. A listing they own none of is absent. */
export async function getRoomInventory(
	db: D1Database,
	roomId: number,
	playerId: number
): Promise<RoomInventoryItem[]> {
	const { results } = await db
		.prepare(
			`SELECT i.player_id AS playerId, i.consumable_id AS consumableId, i.quantity AS quantity
			 FROM room_inventory AS i
			 JOIN room_consumable AS c ON c.room_consumable_id = i.consumable_id
			 WHERE c.room_id = ?1 AND i.player_id = ?2
			 ORDER BY c.modified_at, c.room_consumable_id`
		)
		.bind(roomId, playerId)
		.all<{ playerId: number; consumableId: string; quantity: number }>()

	return results.map((r) => ({
		PlayerId: r.playerId,
		ConsumableId: r.consumableId,
		Quantity: r.quantity,
	}))
}
