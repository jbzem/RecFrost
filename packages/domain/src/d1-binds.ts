/**
 * D1 caps a prepared statement at 100 bound parameters — binding more fails outright with
 * "variable number must be between ?1 and ?100". Every `IN (…)` list built from a caller's
 * array has to respect this, which is easy to miss: the id list behind a bulk lookup (a
 * friends list, a room's subrooms) stays under a hundred right up until it meets a real
 * account, and then the whole endpoint 500s rather than degrading.
 */
export const MAX_BOUND_PARAMS = 100

/**
 * Split values into chunks that fit {@link MAX_BOUND_PARAMS}, one statement each. `reserve`
 * is how many binds the statement spends on something other than the list — a `now` cutoff,
 * a player id — which come out of the same budget.
 */
export function chunkForBinds<T>(values: T[], reserve = 0): T[][] {
	const perChunk = MAX_BOUND_PARAMS - reserve
	const chunks: T[][] = []
	for (let i = 0; i < values.length; i += perChunk) {
		chunks.push(values.slice(i, i + perChunk))
	}
	return chunks
}

/** The `?1,?2,…` placeholder list for one chunk, offset past any binds reserved ahead of it. */
export function bindPlaceholders(chunk: unknown[], offset = 0): string {
	return chunk.map((_, i) => `?${i + 1 + offset}`).join(', ')
}
