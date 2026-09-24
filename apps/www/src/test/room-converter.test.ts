import { expect, it } from 'vitest'

import { downgradeRoom, needsDowngrade } from '../room-converter'

// Hand-built protobuf, since no schema exists for a scene: every expectation below is on
// the wire bytes, which is also all the converter ever looks at.
function varint(value: bigint): number[] {
	const out: number[] = []
	for (;;) {
		const b = Number(value & 0x7fn)
		value >>= 7n
		if (value) {
			out.push(b | 0x80)
		} else {
			out.push(b)
			return out
		}
	}
}
const num = (fn: number, value: bigint | number) => [
	...varint(BigInt(fn << 3)),
	...varint(BigInt(value)),
]
const len = (fn: number, payload: number[]) => [
	...varint(BigInt((fn << 3) | 2)),
	...varint(BigInt(payload.length)),
	...payload,
]
const text = (s: string) => [...new TextEncoder().encode(s)]
const run = (bytes: number[]) => {
	const { data, stats } = downgradeRoom(Uint8Array.from(bytes))
	return { bytes: [...data], stats }
}

const SENTINEL = 0xffff_ffff_ffff_ffffn

it('only a .binpb needs downgrading', () => {
	expect(needsDowngrade('MyRoom.binpb')).toBe(true)
	expect(needsDowngrade('MYROOM.BINPB')).toBe(true)
	expect(needsDowngrade('MyRoom.room')).toBe(false)
	expect(needsDowngrade('binpb')).toBe(false)
})

it('applies all four patches', () => {
	const circuit = len(28, text('Circuit Board'))
	const { bytes, stats } = run([
		...num(1, 9),
		...len(2, [
			...num(3, 7),
			...num(100, SENTINEL),
			...len(14, [...num(1, 4), ...len(5, text('uuid')), ...num(6, 2)]),
			// A circuit two messages down, and one directly on the object.
			...len(7, len(8, [...num(1, 1), ...circuit])),
			...circuit,
		]),
		...circuit,
		...len(9, [...num(1, 1), ...circuit]),
		...num(30, 140),
	])

	expect(bytes).toEqual([
		...num(1, 9),
		...len(2, [
			...num(3, 7),
			...len(14, [...num(1, 4), ...num(6, 2)]),
			...len(7, len(8, num(1, 1))),
		]),
		...len(9, num(1, 1)),
		...num(30, 123),
	])
	expect(stats).toMatchObject({
		schemaVersion: 9,
		originalVersion: 140,
		versionPatched: true,
		objectBlobs: 1,
		objectsModified: 1,
		fn100Removed: 1,
		fn5Removed: 1,
		circuitFieldsRemoved: 4,
	})
	expect(stats.inputBytes - stats.outputBytes).toBeGreaterThan(stats.circuitBytesRemoved)
})

it('keeps an fn100 that is not the sentinel, and only patches the first fn30', () => {
	const input = [...len(2, num(100, 5)), ...num(30, 123), ...num(30, 200)]
	const { bytes, stats } = run(input)
	expect(bytes).toEqual(input)
	expect(stats).toMatchObject({ fn100Removed: 0, objectsModified: 0, versionPatched: false })
})

it('leaves bytes that only look like a circuit field alone', () => {
	// 0xE2 is a field-28 tag, but the string around it doesn't parse as a message end to
	// end, so it is opaque and must survive untouched.
	const input = len(3, [0xe2, 0x01, 0x02, 0x41, 0x42, 0xff])
	expect(run(input).bytes).toEqual(input)
})

it('copies a truncated file through instead of throwing', () => {
	const input = [...num(1, 9), ...len(2, num(3, 7)).slice(0, -1)]
	expect(run(input).bytes).toEqual(input)
	expect(run([]).bytes).toEqual([])
})
