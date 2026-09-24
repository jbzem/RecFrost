/**
 * Room currencies — a room's own money.
 *
 * A creator mints one for their room ("MySpecialTokens"), hands it out for doing things in
 * there, and sells things for it: finish the obstacle course, earn 50 tokens, spend them on a
 * custom shirt at the shop by the door. It is play money for one room, and it means nothing
 * outside it.
 *
 * This module is the CURRENCY ITSELF — its name, its coin art, how fast the room may hand it
 * out. What a player has actually earned is a separate thing, in `room_balance` further down.
 * The endpoints:
 *  - `POST /api/roomcurrencies/v1/createCurrency` mints one
 *  - `POST /api/roomcurrencies/v1/updateCurrency` edits it
 *  - `GET  /api/roomcurrencies/v1/currencies?roomId=` lists a room's
 *  - `POST /api/roomcurrencies/v1/awardCurrency/bulk` pays players
 *  - the purchase offers below are the shop that sells the currency for other money
 *
 * Two things to know before touching it:
 *
 * These must never reach the `balance` table, which is keyed by `(account, currency_type)`
 * alone. That key cannot say WHICH room's currency a row is, so one room's tokens would spend
 * in every other room — see `CurrencyType` in balance-db.ts, where `RoomCurrency` is left out
 * of the spendable set for exactly this reason.
 *
 * And every currency here carries `CurrencyType.RoomCurrency` (300), because that is what the
 * type MEANS: "some room's currency". One is told apart from another by its own `CurrencyId`,
 * never by its type — so the type is a constant on the DTO rather than a column.
 *
 * This worker (`econ`) owns the table and its migrations — see apps/econ/migrations/, 0017,
 * 0018 and 0020.
 */

import { CurrencyType } from './balance-db'

/**
 * Schema DDL — also builds the table in tests. Mirrors the table as it STANDS: 0017 created
 * it, 0018 made `image_name` nullable and 0020 added `purchase_offers`, so this is the three
 * of them together rather than any one file.
 */
export const ROOM_CURRENCY_SCHEMA_DDL: string[] = [
	// `currency_id` is a GUID rather than an autoincrement: it is how the client names this
	// currency everywhere afterwards (its balances, its storefront prices), and a room's
	// currencies are created independently of every other room's, so an id that says nothing
	// about ordering is the honest one.
	//
	// `limit_amount`, not `limit` — `LIMIT` is a SQL keyword, and a column that has to be
	// quoted at every use is a column that will eventually not be. It is the most of this
	// currency the room may award PER DAY, a faucet rate rather than a cap on what a player
	// may hold, and nothing enforces it yet: no day's awards are tracked anywhere.
	//
	// `shape` and `color` are the client's own indices into its coin art (the body sends
	// `Shape=0&Color=19`); nothing here interprets them, they are stored and served back.
	// `color` is signed — the client sends -1 for "no colour chosen".
	//
	// `image_name` is separate and NULLABLE, not empty-string: the client serves null for a
	// currency with no custom coin art, and null is what its model carries. It stays null
	// until a room can upload art — the column is here rather than in a later migration
	// because the client's model has the member either way.
	//
	// `purchase_offers` is the currency's shop, as a JSON array (see
	// {@link RoomCurrencyPurchaseOffer}). A column rather than a table because offers are
	// read, written and replaced as a WHOLE, for one currency at a time.
	`CREATE TABLE IF NOT EXISTS room_currency (
		currency_id TEXT PRIMARY KEY,
		room_id INTEGER NOT NULL,
		name TEXT NOT NULL,
		description TEXT NOT NULL,
		limit_amount INTEGER NOT NULL,
		shape INTEGER NOT NULL,
		color INTEGER NOT NULL,
		image_name TEXT,
		created_at TEXT NOT NULL,
		modified_at TEXT NOT NULL,
		purchase_offers TEXT
	)`,
	// Every read is "this room's currencies" — the whole access pattern.
	`CREATE INDEX IF NOT EXISTS idx_room_currency_room ON room_currency (room_id)`,
]

/**
 * A room currency as the client reads it — its own model, member for member and IN ITS
 * ORDER, taken from the client's field layout rather than inferred. The same object the
 * create endpoint answers with and the `RoomCurrencyCreated`/`Modified` frames carry, which
 * is why `econ.app.ts` assigns one of these straight to a `RoomCurrencyPayload`: that
 * assignment is what stops the two drifting apart.
 *
 * `CurrencyType` is always {@link CurrencyType.RoomCurrency} — see the module doc. `RoomId`
 * is `long?` in the client's model but is never null here: a room currency belongs to a
 * room by definition, and the column is NOT NULL.
 */
export interface RoomCurrency {
	CurrencyId: string
	RoomId: number
	Name: string
	Description: string
	CurrencyType: number
	/**
	 * The most of this currency the room may award PER DAY — a faucet rate, not a ceiling on
	 * what a player may hold. Stored and served; nothing enforces it yet, because nothing
	 * tracks a day's awards.
	 */
	Limit: number
	/** A byte in the client's model — its index into the coin shapes. */
	Shape: number
	Color: number
	/** Null for a currency with no custom coin art, which is every one of them so far. */
	ImageName: string | null
	/** ISO-8601 UTC. */
	CreatedAt: string
	/** ISO-8601 UTC. */
	ModifiedAt: string
}

/** What the create endpoint supplies; the id and timestamps are minted here. */
export interface NewRoomCurrency {
	RoomId: number
	Name: string
	Description: string
	Limit: number
	Shape: number
	Color: number
}

interface RoomCurrencyRow {
	currency_id: string
	room_id: number
	name: string
	description: string
	limit_amount: number
	shape: number
	color: number
	image_name: string | null
	created_at: string
	modified_at: string
}

const SELECT_COLUMNS = `currency_id, room_id, name, description, limit_amount, shape, color, image_name, created_at, modified_at`

const toRoomCurrency = (row: RoomCurrencyRow): RoomCurrency => ({
	CurrencyId: row.currency_id,
	RoomId: row.room_id,
	Name: row.name,
	Description: row.description,
	CurrencyType: CurrencyType.RoomCurrency,
	Limit: row.limit_amount,
	Shape: row.shape,
	Color: row.color,
	ImageName: row.image_name,
	CreatedAt: row.created_at,
	ModifiedAt: row.modified_at,
})

/**
 * Mint a room currency, returning it as the client reads it back.
 *
 * `CreatedAt` and `ModifiedAt` start equal — the client's model carries both and an edit
 * will move only the second, so a never-edited currency reads as created-and-untouched
 * rather than as having no modification time at all.
 */
export async function createRoomCurrency(
	db: D1Database,
	currency: NewRoomCurrency
): Promise<RoomCurrency> {
	const now = new Date().toISOString()
	const row = await db
		.prepare(
			`INSERT INTO room_currency
			   (currency_id, room_id, name, description, limit_amount, shape, color, image_name, created_at, modified_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8)
			 RETURNING ${SELECT_COLUMNS}`
		)
		.bind(
			crypto.randomUUID(),
			currency.RoomId,
			currency.Name,
			currency.Description,
			currency.Limit,
			currency.Shape,
			currency.Color,
			now
		)
		.first<RoomCurrencyRow>()

	return toRoomCurrency(row!)
}

/** One currency by its id, or null when there is no such row. */
export async function getRoomCurrency(
	db: D1Database,
	currencyId: string
): Promise<RoomCurrency | null> {
	const row = await db
		.prepare(`SELECT ${SELECT_COLUMNS} FROM room_currency WHERE currency_id = ?1`)
		.bind(currencyId)
		.first<RoomCurrencyRow>()

	return row ? toRoomCurrency(row) : null
}

/**
 * What an update may change. Everything else about a currency is fixed: `CurrencyId` names
 * it, `RoomId` is the room that minted it (moving one between rooms would strand whatever
 * players hold of it), `CurrencyType` is what it IS, and `CreatedAt` already happened.
 *
 * Every field is optional and an absent one is LEFT ALONE rather than reset. The client sends
 * the whole form, so this only bites a partial request — and there, blanking a description
 * because it wasn't mentioned is the worse of the two readings.
 */
export interface RoomCurrencyEdit {
	Name?: string
	Description?: string
	Limit?: number
	Shape?: number
	Color?: number
}

/**
 * Apply an edit to a currency, returning it as the client reads it back.
 *
 * `ModifiedAt` moves; `CreatedAt` does not. That is the whole point of the client's model
 * carrying both, and it is why the two start equal on a currency that has never been edited.
 *
 * The caller supplies the already-loaded currency (after its room's owner check) both to
 * avoid a re-read and because the merge needs the current values to leave absent fields alone.
 */
export async function updateRoomCurrency(
	db: D1Database,
	currency: RoomCurrency,
	edit: RoomCurrencyEdit
): Promise<RoomCurrency> {
	const merged: RoomCurrency = {
		...currency,
		Name: edit.Name ?? currency.Name,
		Description: edit.Description ?? currency.Description,
		Limit: edit.Limit ?? currency.Limit,
		Shape: edit.Shape ?? currency.Shape,
		Color: edit.Color ?? currency.Color,
		ModifiedAt: new Date().toISOString(),
	}

	await db
		.prepare(
			`UPDATE room_currency
			 SET name = ?2, description = ?3, limit_amount = ?4, shape = ?5, color = ?6, modified_at = ?7
			 WHERE currency_id = ?1`
		)
		.bind(
			merged.CurrencyId,
			merged.Name,
			merged.Description,
			merged.Limit,
			merged.Shape,
			merged.Color,
			merged.ModifiedAt
		)
		.run()

	return merged
}

/**
 * Every currency a room has minted, oldest first — the order they were created in, which is
 * the order the room's owner built them up in and so the one they expect to see.
 */
export async function getRoomCurrencies(db: D1Database, roomId: number): Promise<RoomCurrency[]> {
	const { results } = await db
		.prepare(
			`SELECT ${SELECT_COLUMNS} FROM room_currency WHERE room_id = ?1 ORDER BY created_at, currency_id`
		)
		.bind(roomId)
		.all<RoomCurrencyRow>()

	return results.map(toRoomCurrency)
}

/**
 * One purchase offer on a room currency — a way to BUY that currency with other money, rather
 * than earning it. A room that sells its tokens rather than only handing them out lists them
 * here: "5 MySpecialTokens for 500 Rec Center Tokens". The client's own model, member for
 * member and in its order.
 *
 * `CurrencyId` names the currency being SOLD, so an offer knows its own shop. It is not part
 * of what gets stored: the row the offers live on already says which currency they belong to,
 * and {@link getPurchaseOffers} projects it back in. `Price` is in whatever currency the room
 * charges in, which nothing here records yet — the client's model has no field for it either.
 */
export interface RoomCurrencyPurchaseOffer {
	CurrencyPurchaseOfferId: string
	CurrencyId: string
	Order: number
	Name: string
	CurrencyAmount: number
	Price: number
	/** ISO-8601 UTC. */
	ModifiedAt: string
}

/**
 * An offer as it is STORED in `room_currency.purchase_offers` — everything above except
 * `CurrencyId`, which the owning row already says.
 */
export type StoredPurchaseOffer = Omit<RoomCurrencyPurchaseOffer, 'CurrencyId'>

/**
 * Read a JSON offers column into whole offers, stamping each with the currency it belongs to.
 *
 * Null, an empty column and anything that doesn't parse as an array are all "no offers" — a
 * currency nobody has built a shop for simply has none, and a column that has somehow been
 * corrupted should show an empty shop rather than fail the whole batch.
 */
function parsePurchaseOffers(currencyId: string, json: string | null): RoomCurrencyPurchaseOffer[] {
	if (!json) return []
	let parsed: unknown
	try {
		parsed = JSON.parse(json)
	} catch {
		return []
	}
	if (!Array.isArray(parsed)) return []

	return (parsed as StoredPurchaseOffer[]).map((offer) => ({
		CurrencyPurchaseOfferId: String(offer.CurrencyPurchaseOfferId ?? ''),
		CurrencyId: currencyId,
		Order: Number(offer.Order ?? 0),
		Name: String(offer.Name ?? ''),
		CurrencyAmount: Number(offer.CurrencyAmount ?? 0),
		Price: Number(offer.Price ?? 0),
		ModifiedAt: String(offer.ModifiedAt ?? ''),
	}))
}

/** What the create-offer endpoint supplies; the id and `ModifiedAt` are minted here. */
export interface NewPurchaseOffer {
	Name: string
	CurrencyAmount: number
	Price: number
	Order: number
}

/**
 * Append a purchase offer to a currency's shop, returning it as the client reads it back.
 *
 * Appended IN SQL, with `json_insert(…, '$[#]', …)`, rather than read-modify-written here:
 * two offers added at once would otherwise race, and the second read would overwrite the
 * first's append with a list that never had it. `COALESCE(…, '[]')` covers the null column a
 * currency starts life with, so the first offer needs no separate "create the array" step.
 *
 * The stored object deliberately omits `CurrencyId` — the row it lands on already says which
 * currency these are offers for (see {@link StoredPurchaseOffer}) — but the returned offer
 * carries it, because the client's model does.
 */
export async function createPurchaseOffer(
	db: D1Database,
	currencyId: string,
	offer: NewPurchaseOffer
): Promise<RoomCurrencyPurchaseOffer> {
	const stored: StoredPurchaseOffer = {
		CurrencyPurchaseOfferId: crypto.randomUUID(),
		Order: offer.Order,
		Name: offer.Name,
		CurrencyAmount: offer.CurrencyAmount,
		Price: offer.Price,
		ModifiedAt: new Date().toISOString(),
	}

	await db
		.prepare(
			`UPDATE room_currency
			 SET purchase_offers = json_insert(COALESCE(purchase_offers, '[]'), '$[#]', json(?2))
			 WHERE currency_id = ?1`
		)
		.bind(currencyId, JSON.stringify(stored))
		.run()

	// Built out member by member rather than spread: the client's model puts `CurrencyId`
	// SECOND, and a spread would land it at the end.
	return {
		CurrencyPurchaseOfferId: stored.CurrencyPurchaseOfferId,
		CurrencyId: currencyId,
		Order: stored.Order,
		Name: stored.Name,
		CurrencyAmount: stored.CurrencyAmount,
		Price: stored.Price,
		ModifiedAt: stored.ModifiedAt,
	}
}

/** One currency's shop — the group the batch read answers in, one per currency asked for. */
export interface RoomCurrencyPurchaseOffers {
	CurrencyId: string
	PurchaseOffers: RoomCurrencyPurchaseOffer[]
}

/**
 * The purchase offers of several currencies at once, GROUPED BY CURRENCY — what
 * `getPurchaseOffersBatch` serves.
 *
 * Grouped rather than flat even though every offer already carries its own `CurrencyId`: the
 * group is what says a currency was ASKED ABOUT, which a flat list cannot. A currency with no
 * shop yet still gets a group, with an empty `PurchaseOffers` — "this currency sells nothing"
 * and "you didn't ask about this currency" are different answers.
 *
 * Groups come back in the order the ids were given, each shop sorted by its offers' `Order`,
 * so a caller gets its own batch back in its own order. An id naming no currency at all is
 * omitted, the way the other batch lookups here treat an unknown id — there is no shop to
 * report, empty or otherwise.
 */
export async function getPurchaseOffers(
	db: D1Database,
	currencyIds: string[]
): Promise<RoomCurrencyPurchaseOffers[]> {
	if (currencyIds.length === 0) return []

	const placeholders = currencyIds.map((_, i) => `?${i + 1}`).join(', ')
	const { results } = await db
		.prepare(
			`SELECT currency_id, purchase_offers FROM room_currency WHERE currency_id IN (${placeholders})`
		)
		.bind(...currencyIds)
		.all<{ currency_id: string; purchase_offers: string | null }>()

	const byId = new Map(results.map((r) => [r.currency_id, r.purchase_offers]))

	return currencyIds
		.filter((currencyId) => byId.has(currencyId))
		.map((currencyId) => ({
			CurrencyId: currencyId,
			PurchaseOffers: parsePurchaseOffers(currencyId, byId.get(currencyId) ?? null).sort(
				(a, b) => a.Order - b.Order
			),
		}))
}

/**
 * How much of a room's own money each player has earned — the other half of the feature, the
 * currencies themselves being above.
 *
 * Keyed by CURRENCY, not by currency type, and that difference is the whole point: the
 * account-scoped `balance` table's `(account, currency_type)` key cannot say which room's
 * currency a row is, so one room's tokens would spend in every other room. Room currencies
 * are left out of that table for exactly this reason (see `CurrencyType` in balance-db.ts).
 *
 * A missing row is a balance of zero. Nothing is inserted until a player is first paid, so a
 * room's currency costs a row per player who has actually earned some rather than one per
 * player who has walked in.
 */
export const ROOM_BALANCE_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS room_balance (
		currency_id TEXT NOT NULL,
		player_id INTEGER NOT NULL,
		amount INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (currency_id, player_id)
	)`,
	// "What does this player hold across the room?" walks the currencies, so the reverse
	// lookup earns its own index rather than a scan of every holder of every currency.
	`CREATE INDEX IF NOT EXISTS idx_room_balance_player ON room_balance (player_id)`,
]

/** One player's holding of one room currency. */
export interface RoomBalance {
	CurrencyId: string
	PlayerId: number
	Amount: number
}

/** What an award did: the resulting total, and how much actually landed. */
export interface RoomAwardResult {
	/** The RESULTING total, never the change. */
	Balance: number
	/**
	 * What was actually added. Equal to the delta except where the zero floor bit — a
	 * deduction larger than the balance takes it to zero, not below, and this reports the part
	 * that had somewhere to come from.
	 */
	AmountAwarded: number
}

/**
 * Move a player's holding of a room currency by `delta`, returning what they hold afterwards
 * and how much of the delta actually landed.
 *
 * Floored at zero in the statement itself, so a deduction and a concurrent award can't race
 * a balance negative between a read and a write: a negative `delta` is a deduction, and a
 * player cannot owe a room currency.
 *
 * NOT capped at the currency's `Limit`. `Limit` is the most of a currency a room may award
 * PER DAY — a faucet rate, not a ceiling on what a player may hold — and nothing tracks a
 * day's awards yet, so it is stored and served but enforced nowhere. Clamping a balance to it
 * (as this once did) silently refuses awards a player was entitled to: a `Limit` of 3 left
 * everyone stuck at 3 coins forever.
 *
 * The before-reading, the write and the after-reading go in ONE `batch`, which D1 runs as a
 * transaction, so nothing can change between the two reads but the write between them.
 */
export async function awardRoomCurrency(
	db: D1Database,
	currencyId: string,
	playerId: number,
	delta: number
): Promise<RoomAwardResult> {
	const read = db.prepare(
		'SELECT amount FROM room_balance WHERE currency_id = ?1 AND player_id = ?2'
	)
	const [before, , after] = await db.batch<{ amount: number }>([
		read.bind(currencyId, playerId),
		db
			.prepare(
				`INSERT INTO room_balance (currency_id, player_id, amount)
				 VALUES (?1, ?2, MAX(0, ?3))
				 ON CONFLICT (currency_id, player_id)
				   DO UPDATE SET amount = MAX(0, room_balance.amount + ?3)`
			)
			.bind(currencyId, playerId, delta),
		read.bind(currencyId, playerId),
	])

	// Read BACK rather than taken from a `RETURNING` on the upsert. The two differ in how they
	// fail: a RETURNING that came back empty is indistinguishable from an award that changed
	// nothing, so a write that didn't land would report `AmountAwarded: 0` on a balance that
	// had in fact moved — a plausible-looking answer that is simply wrong. A read is either a
	// row or no row, and no row is a real, correct zero.
	const previous = before.results[0]?.amount ?? 0
	const balance = after.results[0]?.amount ?? 0
	return { Balance: balance, AmountAwarded: balance - previous }
}

/** What a player holds of each of a room's currencies. A currency they've never earned is absent. */
export async function getRoomBalances(
	db: D1Database,
	roomId: number,
	playerId: number
): Promise<RoomBalance[]> {
	const { results } = await db
		.prepare(
			`SELECT b.currency_id AS currencyId, b.player_id AS playerId, b.amount AS amount
			 FROM room_balance AS b
			 JOIN room_currency AS c ON c.currency_id = b.currency_id
			 WHERE c.room_id = ?1 AND b.player_id = ?2
			 ORDER BY c.created_at, c.currency_id`
		)
		.bind(roomId, playerId)
		.all<{ currencyId: string; playerId: number; amount: number }>()

	return results.map((r) => ({
		CurrencyId: r.currencyId,
		PlayerId: r.playerId,
		Amount: r.amount,
	}))
}
