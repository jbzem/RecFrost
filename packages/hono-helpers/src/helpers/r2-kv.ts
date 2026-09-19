/**
 * Free-tier stand-in for Cloudflare R2.
 *
 * R2 is a paid Cloudflare feature, so this lets the same worker code run against a
 * Workers KV namespace instead. It implements the *subset* of the R2 API the workers
 * actually use: `put` / `get` / `head` / `delete` (single or batch) / `list`
 * (prefix/limit/cursor), `httpMetadata` + `customMetadata`,
 * the native `sha256` put checksum (exposed back via `head().checksums.sha256`),
 * conditional GET (`If-None-Match` → 304) and single byte-range reads (206).
 *
 * Wire-up: bind the KV namespace under the same name the code expects (`IMAGES` /
 * `CDN_ASSETS`) in `wrangler.jsonc`, then wrap it at the worker entry with `makeR2()`:
 *
 *   export default { fetch: (req, env, ctx) => app.fetch(req, withR2OverKv(env), ctx) }
 *
 * `withR2OverKv` below does exactly that for an env carrying those two bindings.
 */

export type R2PutOptions = {
	httpMetadata?: Record<string, string>
	customMetadata?: Record<string, string>
	/** SHA-256 checksum, accepted the way R2's `put` accepts `sha256`. */
	sha256?: ArrayBuffer
	onlyIf?: { etagDoesNotMatch?: string }
}

export type R2GetOptions = {
	onlyIf?: { etagDoesNotMatch?: string }
	range?:
		| Headers
		| { offset: number; length: number }
		| { suffix: number }
		| { offset?: number; length?: number }
}

export interface R2ObjectLike {
	key: string
	size: number
	httpEtag: string
	etag?: string
	httpMetadata: Record<string, string>
	customMetadata: Record<string, string>
	checksums?: { sha256?: ArrayBuffer }
	uploaded?: Date
	version?: string
}

export interface R2ObjectBodyLike extends R2ObjectLike {
	arrayBuffer(): Promise<ArrayBuffer>
	/** Absent on a 304 (precondition-matched) response — callers detect that. */
	body?: ReadableStream
	writeHttpMetadata(headers: Headers): void
	range?: { offset: number; length: number }
}

export interface R2Like {
	put(
		key: string,
		value: ArrayBuffer | Uint8Array | string | ReadableStream | Blob,
		opts?: R2PutOptions
	): Promise<void>
	get(key: string, opts?: R2GetOptions): Promise<R2ObjectBodyLike | null>
	head(key: string): Promise<R2ObjectLike | null>
	delete(keys: string | string[]): Promise<void>
	list(opts?: R2ListOptions): Promise<R2ListResult>
}

/** Key listing. `delimiter` / `startAfter` are not emulated (nothing uses them). */
export type R2ListOptions = {
	prefix?: string
	limit?: number
	cursor?: string
}

export type R2ListResult = {
	objects: Array<{ key: string }>
	truncated: boolean
	cursor?: string
}

/** Where R2 `httpMetadata` keys map onto response header names. */
const HTTP_META_HEADERS: Record<string, string> = {
	contentType: 'content-type',
	contentDisposition: 'content-disposition',
	contentEncoding: 'content-encoding',
	contentLanguage: 'content-language',
	cacheControl: 'cache-control',
}

/** Internal KV metadata shape. Namespaced keys keep caller `customMetadata` clean. */
type StoredMeta = {
	__h: string
	__c: string
	__s?: string
	__len: number
	__e: string
}

async function toArrayBuffer(
	value: ArrayBuffer | Uint8Array | string | ReadableStream | Blob
): Promise<ArrayBuffer> {
	if (value instanceof ArrayBuffer) return value
	if (value instanceof Uint8Array) return value.slice().buffer as ArrayBuffer
	if (typeof value === 'string') return new TextEncoder().encode(value).buffer as ArrayBuffer
	if (value instanceof Blob) return await value.arrayBuffer()
	return await new Response(value).arrayBuffer()
}

function abToB64(bytes: ArrayBuffer): string {
	const u = new Uint8Array(bytes)
	let bin = ''
	for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i])
	return btoa(bin)
}

function b64ToAb(b64: string): ArrayBuffer {
	const bin = atob(b64)
	const u = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
	return u.buffer
}

async function etagFor(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	return abToB64(digest).replace(/=+$/, '')
}

/**
 * Resolve a `Range` request to a concrete offset/length over `size`. Mirrors R2's
 * workerd behaviour: an unparsable or unsatisfiable range falls back to the whole
 * object (so it never silently becomes a 200 slice of nothing).
 */
function resolveRange(
	size: number,
	range: R2GetOptions['range']
): { offset: number; length: number } | null {
	if (!range) return null

	let start: number | undefined
	let endInclusive: number | undefined
	let suffix: number | undefined

	if (range instanceof Headers) {
		const h = range.get('range')
		if (!h || !h.startsWith('bytes=')) return null
		const spec = h.slice('bytes='.length)
		// Multi-range requests aren't supported by workerd's single-part answer;
		// R2 answers with the WHOLE object as a 206 (not a 416/200).
		if (spec.includes(',')) return { offset: 0, length: size }
		if (spec.startsWith('-')) {
			suffix = parseInt(spec.slice(1), 10)
		} else {
			const [a, b] = spec.split('-')
			const sa = a === '' ? undefined : parseInt(a, 10)
			const sb = b === '' ? undefined : parseInt(b, 10)
			// `bytes=abc` (no parseable bound) → R2 answers with the whole object as a 206.
			if (Number.isNaN(sa) && Number.isNaN(sb)) return { offset: 0, length: size }
			start = sa
			endInclusive = sb
		}
	} else if ('suffix' in range) {
		suffix = range.suffix
	} else {
		// The { offset, length } form counts bytes (length is a count, not an end).
		start = range.offset
		if (range.length !== undefined && start !== undefined) {
			endInclusive = start + range.length - 1
		}
	}

	let s: number
	let e: number
	if (suffix !== undefined) {
		const len = Math.max(0, suffix)
		s = Math.max(0, size - len)
		e = size - 1
	} else {
		s = start ?? 0
		e = endInclusive ?? size - 1
		e = Math.min(e, size - 1)
		s = Math.max(s, 0)
		// An unsatisfiable range (start past the end) falls back to the whole object.
		if (s > e) {
			s = 0
			e = size - 1
		}
	}

	return { offset: s, length: e - s + 1 }
}

function writeMeta(headers: Headers, httpMetadata: Record<string, string>): void {
	for (const [k, v] of Object.entries(httpMetadata)) {
		const h = HTTP_META_HEADERS[k]
		if (h) headers.set(h, v)
	}
}

/** Wrap a KV namespace so it satisfies the R2-shaped calls the workers make. */
export function makeR2(kv: unknown): R2Like {
	const ns = kv as KVNamespace
	function buildMeta(bytes: ArrayBuffer, opts: R2PutOptions) {
		return {
			__h: JSON.stringify(opts.httpMetadata ?? {}),
			__c: JSON.stringify(opts.customMetadata ?? {}),
			__s: opts.sha256 ? abToB64(opts.sha256) : undefined,
			__len: bytes.byteLength,
			__e: '',
		} satisfies StoredMeta
	}

	function objectFrom(
		key: string,
		bytes: ArrayBuffer,
		meta: StoredMeta | undefined,
		opts: R2GetOptions
	): R2ObjectBodyLike | null {
		if (!meta) return null
		const httpMetadata = JSON.parse(meta.__h ?? '{}') as Record<string, string>
		const customMetadata = JSON.parse(meta.__c ?? '{}') as Record<string, string>
		const etag = meta.__e
		const sha256 = meta.__s ? b64ToAb(meta.__s) : undefined
		const writeHttpMetadata = (h: Headers) => writeMeta(h, httpMetadata)

		// Conditional GET: `If-None-Match` matched → 304 with no `body` key.
		if (opts.onlyIf?.etagDoesNotMatch && opts.onlyIf.etagDoesNotMatch === etag) {
			return {
				key,
				size: meta.__len,
				httpEtag: `"${etag}"`,
				etag,
				httpMetadata,
				customMetadata,
				checksums: { sha256 },
				uploaded: new Date(),
				// Present so the shape matches a body object, but never reached: a
				// 304 response carries no body (callers detect `!('body' in object)`).
				arrayBuffer: async () => {
					throw new Error('R2OverKV: 304 response has no body')
				},
				writeHttpMetadata,
			}
		}

		const r = resolveRange(meta.__len, opts.range)
		const served = r ? bytes.slice(r.offset, r.offset + r.length) : bytes
		return {
			key,
			size: meta.__len,
			arrayBuffer: async () => served,
			body: new Response(served).body as ReadableStream,
			httpEtag: `"${etag}"`,
			etag,
			httpMetadata,
			customMetadata,
			range: r ? { offset: r.offset, length: r.length } : undefined,
			checksums: { sha256 },
			uploaded: new Date(),
			writeHttpMetadata,
		}
	}

	return {
		async put(key, value, opts = {}) {
			const bytes = await toArrayBuffer(value)
			const meta = buildMeta(bytes, opts)
			meta.__e = await etagFor(bytes)
			await ns.put(key, bytes, { metadata: meta })
		},

		async get(key, opts = {}) {
			const res = await ns.getWithMetadata<StoredMeta>(key, { type: 'arrayBuffer' })
			if (!res.value) return null
			return objectFrom(key, res.value, res.metadata ?? undefined, opts)
		},

		async head(key) {
			const res = await ns.getWithMetadata<StoredMeta>(key, { type: 'arrayBuffer' })
			if (!res.value) return null
			const meta = res.metadata ?? undefined
			if (!meta) return null
			const httpMetadata = JSON.parse(meta.__h ?? '{}') as Record<string, string>
			const customMetadata = JSON.parse(meta.__c ?? '{}') as Record<string, string>
			const sha256 = meta.__s ? b64ToAb(meta.__s) : undefined
			return {
				key,
				size: meta.__len,
				httpEtag: `"${meta.__e}"`,
				etag: meta.__e,
				httpMetadata,
				customMetadata,
				checksums: { sha256 },
				uploaded: new Date(),
				version: meta.__e,
			}
		},

		async delete(keys: string | string[]) {
			for (const key of Array.isArray(keys) ? keys : [keys]) {
				await ns.delete(key)
			}
		},

		async list(opts: R2ListOptions = {}): Promise<R2ListResult> {
			const res = await ns.list({
				...(opts.prefix !== undefined ? { prefix: opts.prefix } : {}),
				...(opts.limit !== undefined ? { limit: opts.limit } : {}),
				...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
			})
			// The result is a union: only the incomplete page carries `cursor`.
			const cursor =
				'cursor' in res && typeof res.cursor === 'string' && res.cursor !== ''
					? res.cursor
					: undefined
			return {
				objects: res.keys.map((k) => ({ key: k.name })),
				truncated: !res.list_complete,
				...(cursor !== undefined ? { cursor } : {}),
			}
		},
	}
}

/**
 * Wrap a worker env so its `IMAGES` / `CDN_ASSETS` KV bindings present as R2 buckets.
 * Bind the KV namespaces under those exact names in `wrangler.jsonc`.
 */
export function withR2OverKv<T extends { IMAGES: unknown; CDN_ASSETS: unknown }>(env: T): T {
	return {
		...env,
		IMAGES: makeR2(env.IMAGES as unknown as KVNamespace),
		CDN_ASSETS: makeR2(env.CDN_ASSETS as unknown as KVNamespace),
	} as T
}
