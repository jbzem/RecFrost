/**
 * The player settings map in the `RECFLARE_PLAYER_SETTINGS` KV namespace.
 *
 * One key per player, `player:<accountId>`, holding every setting they have as a flat
 * `{ [Key]: Value }` record of strings — OOBE state, tutorial mask, chat privacy, the lot.
 * The `playersettings` worker owns the namespace but `api`, `match` and `chat` each keep a
 * setting of their own in the same map, so every writer merges into the record rather than
 * replacing it, and all of them go through here.
 *
 * KV writes cost roughly ten times a read and are capped at one per second per key, and the
 * client is noisy: it re-posts settings it already has at every login and menu change. Every
 * write site has to read the map first to merge into it, so comparing the result against what
 * was read is free — {@link putPlayerSettingsIfChanged} skips the `put` when the merged map
 * is the one already stored.
 */

export type PlayerSettings = Record<string, string>

/** The KV key holding a player's settings. */
export function playerSettingsKey(accountId: number): string {
	return `player:${accountId}`
}

/**
 * The player's stored settings, or null when they have none. A KV failure THROWS rather than
 * reading as "none": a writer that mistook an outage for an empty map would then store its
 * one key over everything the player had. Read-only callers that would rather degrade wrap
 * this in their own `.catch`.
 */
export async function readPlayerSettings(
	kv: KVNamespace,
	accountId: number
): Promise<PlayerSettings | null> {
	return kv.get<PlayerSettings>(playerSettingsKey(accountId), 'json')
}

/** Whether two settings maps hold the same keys with the same values. Order is irrelevant. */
export function samePlayerSettings(a: PlayerSettings | null, b: PlayerSettings | null): boolean {
	const left = a ?? {}
	const right = b ?? {}
	const keys = Object.keys(left)
	if (keys.length !== Object.keys(right).length) return false
	return keys.every((key) => key in right && left[key] === right[key])
}

/**
 * Store `next` as the player's settings unless it is what `existing` already says, in which
 * case nothing is written. Returns whether a write happened.
 *
 * `existing` is the map the caller read to build `next` from; passing the map it read (not a
 * fresh read) is the point — the comparison costs no KV operation.
 */
export async function putPlayerSettingsIfChanged(
	kv: KVNamespace,
	accountId: number,
	existing: PlayerSettings | null,
	next: PlayerSettings
): Promise<boolean> {
	if (existing !== null && samePlayerSettings(existing, next)) return false
	await kv.put(playerSettingsKey(accountId), JSON.stringify(next))
	return true
}

/**
 * Merge `patch` into the player's settings, writing only if a value actually changed. The
 * result carries the merged map (what the player now has) and whether KV was written.
 *
 * Read-modify-write on KV isn't atomic; racing writers here means one player toggling two
 * of their own options in the same instant, which every caller has accepted since before
 * this helper existed.
 */
export async function mergePlayerSettings(
	kv: KVNamespace,
	accountId: number,
	patch: PlayerSettings
): Promise<{ settings: PlayerSettings; written: boolean }> {
	const existing = await readPlayerSettings(kv, accountId)
	const settings: PlayerSettings = { ...existing, ...patch }
	const written = await putPlayerSettingsIfChanged(kv, accountId, existing, settings)
	return { settings, written }
}
