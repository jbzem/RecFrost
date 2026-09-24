/**
 * Downgrade a newer Rec Room scene file (`.binpb`) into one the build this server runs can
 * parse. A port of `recroom_downgrader.py` v4, producing the same bytes it does.
 *
 * A scene is a protobuf message with no schema available, so everything here works on the
 * wire format — field numbers and wire types — and never on meaning. Four patches:
 *
 *   1. fn30, the minimum version the file asks for → 123 (first top-level occurrence).
 *   2. fn100 = 0xFFFFFFFFFFFFFFFF, stripped from each object blob (top-level fn2).
 *   3. fn14.fn5, stripped from each object's fn14 sub-message.
 *   4. fn28, the circuit layer, removed WHEREVER it occurs in the message tree. Done at the
 *      field level rather than by searching for strings, so half a circuit graph is never
 *      left behind.
 *
 * A nested value is only treated as a message if the whole of it parses as one; anything
 * else is left byte-for-byte alone. A parse error never throws out of here — the rest of
 * the input is copied through unchanged, which is what the original does.
 *
 * Untouched fields are copied as their original bytes. The original decodes and re-encodes
 * their varints instead, so the two differ only on an overlong varint, which no protobuf
 * writer emits.
 *
 * No runtime dependencies, so it's safe to pull into the client bundle.
 */

const FN100_SENTINEL = 0xffff_ffff_ffff_ffffn
const TARGET_VERSION = 123
const CIRCUIT_FIELD = 28

const WT_VARINT = 0
const WT_FIXED64 = 1
const WT_LEN = 2
const WT_FIXED32 = 5

export interface DowngradeStats {
	schemaVersion: number
	originalVersion: number
	versionPatched: boolean
	objectBlobs: number
	objectsModified: number
	fn100Removed: number
	fn5Removed: number
	circuitFieldsRemoved: number
	circuitBytesRemoved: number
	inputBytes: number
	outputBytes: number
}

/**
 * Whether a scene file is, by its name, the newer format. Only a default: the upload form
 * ticks its convert box from this and the owner decides.
 */
export function needsDowngrade(filename: string): boolean {
	return filename.toLowerCase().endsWith('.binpb')
}

/**
 * A varint as a double. Nothing here needs one exactly past 2^53: a length that large is
 * past the end of any buffer, and a field number that large matches none of the ones
 * patched. A value that overflows to Infinity compares the same way, so a run of garbage
 * is refused rather than mis-read. The one value that IS needed exactly, fn100's, goes
 * through `readVarintBig`.
 */
function readVarint(data: Uint8Array, pos: number): [value: number, pos: number] {
	let result = 0
	let scale = 1
	while (pos < data.length) {
		const b = data[pos++]
		result += (b & 0x7f) * scale
		if (!(b & 0x80)) return [result, pos]
		scale *= 128
	}
	throw new Error('truncated varint')
}

function readVarintBig(data: Uint8Array, pos: number): [value: bigint, pos: number] {
	let result = 0n
	let shift = 0n
	while (pos < data.length) {
		const b = data[pos++]
		result |= BigInt(b & 0x7f) << shift
		if (!(b & 0x80)) return [result, pos]
		shift += 7n
	}
	throw new Error('truncated varint')
}

/**
 * A field's tag. The wire type is read off the first byte, where its three bits always
 * are, so it stays exact however large the varint runs.
 */
function readTag(data: Uint8Array, pos: number): [fn: number, wt: number, pos: number] {
	const wt = data[pos] & 7
	const [tag, next] = readVarint(data, pos)
	return [Math.floor(tag / 8), wt, next]
}

function encodeVarint(value: number): Uint8Array {
	const out: number[] = []
	for (;;) {
		const b = value % 128
		value = Math.floor(value / 128)
		if (value) {
			out.push(b | 0x80)
		} else {
			out.push(b)
			break
		}
	}
	return Uint8Array.from(out)
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
	let pos = 0
	for (const part of parts) {
		out.set(part, pos)
		pos += part.length
	}
	return out
}

/** A length-delimited field rebuilt around a new payload, keeping its original tag bytes. */
function withPayload(tag: Uint8Array, payload: Uint8Array): Uint8Array[] {
	return [tag, encodeVarint(payload.length), payload]
}

/** The position immediately after a field's value. Throws if it runs off the end. */
function skipField(data: Uint8Array, pos: number, wt: number): number {
	if (wt === WT_VARINT) return readVarint(data, pos)[1]
	let end: number
	if (wt === WT_FIXED64) {
		end = pos + 8
	} else if (wt === WT_LEN) {
		const [length, payloadPos] = readVarint(data, pos)
		end = payloadPos + length
	} else if (wt === WT_FIXED32) {
		end = pos + 4
	} else {
		throw new Error(`unsupported protobuf wire type ${wt}`)
	}
	if (end > data.length) throw new Error('truncated field')
	return end
}

/** Recursively remove fn28 from a blob already known to parse as a message. */
function stripCircuitFields(blob: Uint8Array, stats: DowngradeStats): Uint8Array {
	const out: Uint8Array[] = []
	let pos = 0
	while (pos < blob.length) {
		const fieldStart = pos
		try {
			const [fn, wt, valuePos] = readTag(blob, pos)

			if (fn === CIRCUIT_FIELD) {
				const fieldEnd = skipField(blob, valuePos, wt)
				stats.circuitFieldsRemoved += 1
				stats.circuitBytesRemoved += fieldEnd - fieldStart
				pos = fieldEnd
				continue
			}

			if (wt === WT_LEN) {
				const [length, payloadPos] = readVarint(blob, valuePos)
				const payloadEnd = payloadPos + length
				if (payloadEnd > blob.length) throw new Error('truncated length-delimited field')

				const [payload, removed] = stripCircuitFieldsSafe(
					blob.subarray(payloadPos, payloadEnd),
					stats
				)
				if (removed) {
					out.push(...withPayload(blob.subarray(fieldStart, valuePos), payload))
				} else {
					out.push(blob.subarray(fieldStart, payloadEnd))
				}
				pos = payloadEnd
				continue
			}

			const fieldEnd = skipField(blob, valuePos, wt)
			out.push(blob.subarray(fieldStart, fieldEnd))
			pos = fieldEnd
		} catch {
			out.push(blob.subarray(fieldStart))
			break
		}
	}
	return concat(out)
}

/**
 * `stripCircuitFields`, but only for a blob that parses as a message end to end — which is
 * what tells "a message with no circuits in it" from a string or other opaque bytes.
 */
function stripCircuitFieldsSafe(
	blob: Uint8Array,
	stats: DowngradeStats
): [blob: Uint8Array, removed: boolean] {
	const before = stats.circuitFieldsRemoved
	try {
		let pos = 0
		while (pos < blob.length) {
			const [, wt, valuePos] = readTag(blob, pos)
			pos = skipField(blob, valuePos, wt)
		}
	} catch {
		return [blob, false]
	}
	const stripped = stripCircuitFields(blob, stats)
	return [stripped, stats.circuitFieldsRemoved > before]
}

/**
 * An fn14 sub-message with field 5 (the LinkedItem UUID) removed. Lengths are deliberately
 * NOT bounds-checked, as in the original: a field that runs off the end is kept, clamped
 * to what is there, and ends the walk.
 */
function stripFn5FromFn14(blob: Uint8Array): Uint8Array {
	const out: Uint8Array[] = []
	let pos = 0
	while (pos < blob.length) {
		const fieldStart = pos
		try {
			const [fn, wt, valuePos] = readTag(blob, pos)
			let fieldEnd: number
			if (wt === WT_VARINT) {
				fieldEnd = readVarint(blob, valuePos)[1]
			} else if (wt === WT_LEN) {
				const [length, payloadPos] = readVarint(blob, valuePos)
				fieldEnd = payloadPos + length
			} else if (wt === WT_FIXED32) {
				fieldEnd = valuePos + 4
			} else if (wt === WT_FIXED64) {
				fieldEnd = valuePos + 8
			} else {
				out.push(blob.subarray(fieldStart))
				break
			}
			if (fn !== 5) out.push(blob.subarray(fieldStart, fieldEnd))
			pos = fieldEnd
		} catch {
			out.push(blob.subarray(fieldStart))
			break
		}
	}
	return concat(out)
}

/** One object (top-level fn2): strip fn100 and fn14.fn5, and remove circuit fields below it. */
function processObjectBlob(blob: Uint8Array, stats: DowngradeStats): Uint8Array {
	const out: Uint8Array[] = []
	let pos = 0
	let changed = false
	while (pos < blob.length) {
		const fieldStart = pos
		try {
			const [fn, wt, valuePos] = readTag(blob, pos)

			if (fn === CIRCUIT_FIELD) {
				const fieldEnd = skipField(blob, valuePos, wt)
				stats.circuitFieldsRemoved += 1
				stats.circuitBytesRemoved += fieldEnd - fieldStart
				changed = true
				pos = fieldEnd
				continue
			}

			if (fn === 100 && wt === WT_VARINT) {
				const [value, fieldEnd] = readVarintBig(blob, valuePos)
				if (value === FN100_SENTINEL) {
					stats.fn100Removed += 1
					changed = true
				} else {
					out.push(blob.subarray(fieldStart, fieldEnd))
				}
				pos = fieldEnd
				continue
			}

			if (fn === 14 && wt === WT_LEN) {
				// Not bounds-checked, as in the original: an fn14 that runs off the end is
				// clamped, and comes out re-framed at the length that was really there.
				const [length, payloadPos] = readVarint(blob, valuePos)
				const stripped = stripFn5FromFn14(blob.subarray(payloadPos, payloadPos + length))
				if (stripped.length !== length) {
					stats.fn5Removed += 1
					changed = true
				}
				out.push(...withPayload(blob.subarray(fieldStart, valuePos), stripped))
				pos = payloadPos + length
				continue
			}

			if (wt === WT_LEN) {
				const [length, payloadPos] = readVarint(blob, valuePos)
				const payloadEnd = payloadPos + length
				if (payloadEnd > blob.length) throw new Error('truncated nested object')

				const [payload, removed] = stripCircuitFieldsSafe(
					blob.subarray(payloadPos, payloadEnd),
					stats
				)
				if (removed) {
					out.push(...withPayload(blob.subarray(fieldStart, valuePos), payload))
					changed = true
				} else {
					out.push(blob.subarray(fieldStart, payloadEnd))
				}
				pos = payloadEnd
				continue
			}

			let fieldEnd: number
			if (wt === WT_VARINT) {
				fieldEnd = readVarint(blob, valuePos)[1]
			} else if (wt === WT_FIXED32) {
				fieldEnd = valuePos + 4
			} else if (wt === WT_FIXED64) {
				fieldEnd = valuePos + 8
			} else {
				out.push(blob.subarray(fieldStart))
				break
			}
			out.push(blob.subarray(fieldStart, fieldEnd))
			pos = fieldEnd
		} catch {
			out.push(blob.subarray(fieldStart))
			break
		}
	}
	if (changed) stats.objectsModified += 1
	return concat(out)
}

/**
 * Set the first top-level fn30 varint to the target version. The walk stops at the first
 * thing it can't read, so an fn30 behind a malformed field is left as it was.
 */
function patchFn30(data: Uint8Array<ArrayBuffer>, stats: DowngradeStats): Uint8Array<ArrayBuffer> {
	let pos = 0
	try {
		while (pos < data.length) {
			const [fn, wt, valuePos] = readTag(data, pos)

			if (fn === 30 && wt === WT_VARINT) {
				const [value, fieldEnd] = readVarint(data, valuePos)
				stats.originalVersion = value
				stats.versionPatched = value !== TARGET_VERSION
				return concat([
					data.subarray(0, pos),
					encodeVarint(30 * 8 + WT_VARINT),
					encodeVarint(TARGET_VERSION),
					data.subarray(fieldEnd),
				])
			}

			if (wt === WT_VARINT) {
				pos = readVarint(data, valuePos)[1]
			} else if (wt === WT_LEN) {
				const [length, payloadPos] = readVarint(data, valuePos)
				pos = payloadPos + length
			} else if (wt === WT_FIXED32) {
				pos = valuePos + 4
			} else if (wt === WT_FIXED64) {
				pos = valuePos + 8
			} else {
				break
			}
		}
	} catch {
		// Unreadable from here on: nothing to patch.
	}
	return data
}

/** Downgrade a scene file. Never throws on malformed input — see the note at the top. */
export function downgradeRoom(data: Uint8Array): {
	data: Uint8Array<ArrayBuffer>
	stats: DowngradeStats
} {
	const stats: DowngradeStats = {
		schemaVersion: 0,
		originalVersion: 0,
		versionPatched: false,
		objectBlobs: 0,
		objectsModified: 0,
		fn100Removed: 0,
		fn5Removed: 0,
		circuitFieldsRemoved: 0,
		circuitBytesRemoved: 0,
		inputBytes: data.length,
		outputBytes: 0,
	}

	const out: Uint8Array[] = []
	let pos = 0
	while (pos < data.length) {
		const fieldStart = pos
		try {
			const [fn, wt, valuePos] = readTag(data, pos)

			if (fn === CIRCUIT_FIELD) {
				const fieldEnd = skipField(data, valuePos, wt)
				stats.circuitFieldsRemoved += 1
				stats.circuitBytesRemoved += fieldEnd - fieldStart
				pos = fieldEnd
				continue
			}

			if (wt === WT_VARINT) {
				const [value, fieldEnd] = readVarint(data, valuePos)
				if (fn === 1) stats.schemaVersion = value
				out.push(data.subarray(fieldStart, fieldEnd))
				pos = fieldEnd
			} else if (wt === WT_LEN) {
				const [length, payloadPos] = readVarint(data, valuePos)
				const payloadEnd = payloadPos + length
				if (payloadEnd > data.length) throw new Error('truncated top-level field')
				const blob = data.subarray(payloadPos, payloadEnd)
				const tag = data.subarray(fieldStart, valuePos)

				if (fn === 2) {
					stats.objectBlobs += 1
					out.push(...withPayload(tag, processObjectBlob(blob, stats)))
				} else {
					const [payload, removed] = stripCircuitFieldsSafe(blob, stats)
					if (removed) {
						out.push(...withPayload(tag, payload))
					} else {
						out.push(data.subarray(fieldStart, payloadEnd))
					}
				}
				pos = payloadEnd
			} else if (wt === WT_FIXED32) {
				out.push(data.subarray(fieldStart, valuePos + 4))
				pos = valuePos + 4
			} else if (wt === WT_FIXED64) {
				out.push(data.subarray(fieldStart, valuePos + 8))
				pos = valuePos + 8
			} else {
				out.push(data.subarray(fieldStart))
				break
			}
		} catch {
			out.push(data.subarray(fieldStart))
			break
		}
	}

	const result = patchFn30(concat(out), stats)
	stats.outputBytes = result.length
	return { data: result, stats }
}
