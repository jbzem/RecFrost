/**
 * #photo-feed Discord announcer — the moment a photo lands, not a poll.
 *
 * Hooked into `POST /api/images/v4/uploadsaved` (routes/images.ts): after the
 * bytes and the metadata row are stored, a slideshow-eligible photo
 * (ShareCamera + Accessibility 0/1 — the same filter `getSlideshowImages`
 * serves the homepage with) is announced to the RecFrost Discord's photo
 * channel via an incoming webhook. Fire-and-forget through
 * `executionCtx.waitUntil`, so the upload response never waits on Discord and
 * a dead webhook can never fail an upload — every failure path returns
 * silently.
 *
 * The webhook URL lives in the shared Secrets Store as
 * `DISCORD_PHOTOFEED_WEBHOOK` (bound in wrangler.jsonc with a `local`
 * store_id, swapped at deploy like JWT_SECRET). No binding or no secret, no
 * posts — uploads work exactly as before.
 */
export interface PhotoFeedPhoto {
	/** Uploader's account id (resolves the username, `Player<id>` fallback). */
	playerId: number
	/** Room the photo was taken in, if any (name resolved, omitted if none). */
	roomId: number | null
	/** Bucket key, e.g. `sharecamera/2026-09-18/<uuid>.png`. */
	imageName: string
}

/** The slice of the worker Env the announcer touches — everything optional. */
export interface PhotoFeedEnv {
	DB: D1Database
	DOMAIN: string
	/** Raw SUBDOMAINS var JSON; absent in tests/local, where `img` is the default. */
	SUBDOMAINS?: string
	DISCORD_PHOTOFEED_WEBHOOK?: SecretsStoreSecret
}

/**
 * The channel card, built from scratch: one embed holding the uploader's
 * line, the room line naming where the photo was taken, and the photo large
 * below them. A photo with no resolvable room reads `PRIVATE ROOM` rather
 * than naming `null`. The frost-blue sidebar is the RecFrost accent, matching
 * the site.
 */
export function buildPhotoFeedPayload(username: string, roomName: string | null, imageUrl: string) {
	return {
		embeds: [
			{
				description: `${username} uploaded a photo!\n**Photo Taken in Room: ${roomName ?? 'PRIVATE ROOM'}**`,
				image: { url: imageUrl },
				color: 0x7cc7ff,
			},
		],
	}
}

/**
 * The `img` host with the operator's subdomain override applied — the same
 * rule `ns` advertises in `buildEndpoints` (overrides keyed by default
 * subdomain). Malformed JSON falls back to `img` rather than throwing: this
 * runs behind an upload and must not invent failures.
 */
export function photoImageBase(domain: string, subdomains?: string): string {
	let sub = 'img'
	try {
		const parsed: unknown = JSON.parse(subdomains ?? '')
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			const override = (parsed as Record<string, unknown>).img
			if (typeof override === 'string' && override !== '') sub = override
		}
	} catch {
		// Keep the default host.
	}
	return `https://${sub}.${domain}`
}

/**
 * How long the announcer waits after the upload before posting, so the bytes
 * have replicated to whatever edge Discord fetches from.
 *
 * Why: photo bytes live in KV (R2 is disabled, see `r2-kv`), which is
 * eventually consistent — and the `img` worker answers a key it can't see yet
 * with `DefaultProfileImage.jpg` and a 200, so the client never renders
 * broken. Discord fetches the embed image within seconds of the post and
 * caches what it got FOREVER for that message: post instantly and a fast
 * photo announces the orange droplet instead of the scene, permanently. 20s
 * covers KV propagation in essentially all cases while staying comfortably
 * inside `waitUntil` lifetimes; photos simply appear ~20s after the upload.
 */
export const PHOTOFEED_ANNOUNCE_DELAY_MS = 20_000

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms))

async function resolveUsername(db: D1Database, playerId: number): Promise<string> {
	const row = await db
		.prepare(
			`SELECT json_extract(data, '$.username') AS username FROM account WHERE account_id = ?1`
		)
		.bind(playerId)
		.first<{ username: string | null }>()
	// Same fallback the slideshow feed uses for accounts not in the table.
	return row?.username ?? `Player${playerId}`
}

async function resolveRoomName(db: D1Database, roomId: number | null): Promise<string | null> {
	if (roomId === null) return null
	const row = await db
		.prepare(`SELECT json_extract(data, '$.Name') AS name FROM room WHERE room_id = ?1`)
		.bind(roomId)
		.first<{ name: string | null }>()
	return row?.name ?? null
}

/**
 * Post one photo to the channel webhook. Never throws — call it behind
 * `waitUntil` and forget it. `fetchImpl`/`sleepImpl` exist for tests: stubs
 * asserting the payload and the pre-post delay without touching Discord or
 * waiting out the clock.
 */
export async function announcePhotoFeed(
	env: PhotoFeedEnv,
	photo: PhotoFeedPhoto,
	fetchImpl: typeof fetch = fetch,
	sleepImpl: (ms: number) => Promise<void> = defaultSleep
): Promise<void> {
	try {
		const webhook = await env.DISCORD_PHOTOFEED_WEBHOOK?.get()
		if (!webhook) return
		// Let the bytes replicate before Discord fetches (see
		// PHOTOFEED_ANNOUNCE_DELAY_MS): the names resolve while it waits.
		const [username, roomName] = await Promise.all([
			resolveUsername(env.DB, photo.playerId),
			resolveRoomName(env.DB, photo.roomId),
			sleepImpl(PHOTOFEED_ANNOUNCE_DELAY_MS),
		])
		const imageUrl = `${photoImageBase(env.DOMAIN, env.SUBDOMAINS)}/${photo.imageName}`
		// Explicit UA: Discord's edge challenges UA-less API posts (HTTP 403/1010),
		// which would silently eat every announcement.
		await fetchImpl(webhook, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'user-agent': 'RecFrost-PhotoFeed/1.0' },
			body: JSON.stringify(buildPhotoFeedPayload(username, roomName, imageUrl)),
		})
	} catch {
		// A dead webhook, a missing secret, a down Discord — none of it may fail the upload.
	}
}
