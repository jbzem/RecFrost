/**
 * The currency vocabulary — which currencies exist and what a player starts with — and the
 * operator's Plus token reload, which is SQL text built from them.
 *
 * Separate from `balance-db.ts` for the same reason `catalog-load.ts` is separate from
 * `catalog-db.ts`: that module types its queries with `D1Database`, a Workers type, and the
 * `runx admin reload-plus` CLI (@repo/tools) that runs the reload is a plain Node process
 * with no such types. Nothing here imports anything, so both sides can use it; `balance-db.ts`
 * re-exports all of it, so the worker keeps importing from there.
 */

/**
 * The currencies the client knows about (its `CurrencyType` enum, obfuscated
 * `GKPEKOLBBJL` — which lists every member below except `RoomInventoryItem`). The client sends
 * these ints in the balance/storefront paths — `/api/storefronts/v4/balance/2` is
 * RecCenterTokens — so the values are fixed by the client, not by us.
 *
 * What each one is:
 *  - `Invalid` (0): the enum's zero value. Never a real balance; a request for it is
 *    a client bug or a probe, and `isSpendable` rejects it.
 *  - `LaserTagTickets` (1): earned in the Laser Tag activity, spent in its own store.
 *  - `RecCenterTokens` (2): THE general-purpose currency — what players mean by
 *    "tokens", earned everywhere and spent in the avatar/gift-drop storefronts. This
 *    is the only one the client fetches on load, and the only one we grant at signup.
 *  - `LostSkullsGold` (100) / `DraculaSilver` (101): per-activity currencies for the
 *    Isle of Lost Skulls and Rise of Jumbo quests. Earned and spent inside those
 *    activities only.
 *  - `RecRoyaleSeason1` (200): a season currency for Rec Royale; legacy, no live faucet.
 *  - `RoomCurrency` (300) / `RoomInventoryItem` (301): NOT global balances. These are
 *    scoped to a specific room and served by the `/api/roomcurrencies/*` and
 *    `/api/roomconsumables/*` endpoints, whose rows are keyed by room as well as by
 *    account. They must never be stored in this (account, currency) table — a single
 *    row here couldn't say WHICH room's currency it is, so a player's coins in one
 *    room would spend in every other. `isSpendable` rejects them for that reason.
 *  - `ProgressionEvent` (400): an XP/progression counter the client models as a
 *    currency. Not spendable.
 *  - `RoomieCredits` (500): the newest member of the client's enum. Nothing here grants or
 *    spends it yet; it is listed so the enum matches the client's and a value arriving on
 *    the wire has a name rather than reading as an unknown number.
 */
export const CurrencyType = {
	Invalid: 0,
	LaserTagTickets: 1,
	RecCenterTokens: 2,
	LostSkullsGold: 100,
	DraculaSilver: 101,
	RecRoyaleSeason1: 200,
	RoomCurrency: 300,
	RoomInventoryItem: 301,
	ProgressionEvent: 400,
	RoomieCredits: 500,
} as const

export type CurrencyTypeValue = (typeof CurrencyType)[keyof typeof CurrencyType]

/**
 * The signup grant, in RecCenterTokens, when the `STARTING_TOKENS` var is unset.
 * An operator overrides it in wrangler.jsonc `vars`; 0 is a valid setting and means
 * players start broke.
 */
export const DEFAULT_STARTING_TOKENS = 10_000

/**
 * The periodic Rec Room Plus token reload: credit `amount` RecCenterTokens to every account
 * whose `hasPlus` flag is set, in ONE statement. Run by the operator from the CLI
 * (`just reload-plus <amount>`), which is why this is SQL text rather than a `D1Database`
 * helper — `wrangler d1 execute --command` takes a statement, not bindings, so the two
 * numbers are validated here and inlined as integer literals.
 *
 * Subscribers are found through `account.has_plus`, the generated column with the partial
 * index (auth migration 0009); the predicate must stay exactly `has_plus = 1` for the
 * index to be used.
 *
 * A subscriber with NO balance row yet is one who has never touched econ, so their signup
 * grant (`ensureStartingBalances`) is still pending. Their row is created here with
 * `startingTokens + amount` — the grant and the reload together — because a row holding
 * only the reload would make `ensureStartingBalances` skip the grant forever (the grant is
 * "row exists → already granted"). Existing rows simply gain `amount`, whatever they hold,
 * including a 0 spent down to. Same `startingTokens` rule as everywhere else: it is the
 * operator's `STARTING_TOKENS`, passed in, never a module default read here.
 *
 * `RETURNING` reports each credited account and its resulting balance, since wrangler's
 * meta carries no reliable change count.
 */
export function plusReloadSql(amount: number, startingTokens: number): string {
	if (!Number.isInteger(amount) || amount <= 0) {
		throw new Error(`plusReloadSql: amount must be a positive integer, got ${amount}`)
	}
	if (!Number.isInteger(startingTokens) || startingTokens < 0) {
		throw new Error(
			`plusReloadSql: startingTokens must be a non-negative integer, got ${startingTokens}`
		)
	}
	return `INSERT INTO balance (account_id, currency_type, amount)
		SELECT account_id, ${CurrencyType.RecCenterTokens}, ${startingTokens + amount}
		FROM account WHERE has_plus = 1
		ON CONFLICT (account_id, currency_type) DO UPDATE SET amount = amount + ${amount}
		RETURNING account_id, amount`
}

/**
 * Every Plus subscriber with their current RecCenterTokens balance — NULL for one whose
 * signup grant is still pending (see `plusReloadSql`). The read half of the reload: what
 * the CLI shows before it credits, and all a `--dry-run` does.
 */
export const PLUS_MEMBERS_SQL = `SELECT a.account_id, json_extract(a.data, '$.username') AS username, b.amount
	FROM account a
	LEFT JOIN balance b ON b.account_id = a.account_id AND b.currency_type = ${CurrencyType.RecCenterTokens}
	WHERE a.has_plus = 1
	ORDER BY a.account_id`
