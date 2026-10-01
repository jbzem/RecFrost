/**
 * Read an integer worker var, falling back to `fallback` when it is unset or unusable.
 *
 * A var arrives as a number when it's declared in wrangler.jsonc `vars`, but as a string
 * when it's set anywhere else (the dashboard, `wrangler deploy --var`, `.dev.vars`), so
 * both have to be accepted — the same var is a different type depending on where the
 * operator set it.
 *
 * Anything that isn't a finite integer (an empty string, a typo, `3.5`) is treated as
 * unset rather than coerced: `Number.parseInt` would read `"3abc"` as 3 and `"3.9"` as 3,
 * which turns a typo into a silently wrong limit. Falling back to the documented default
 * is the safe failure here.
 */
export function intVar(value: unknown, fallback: number): number {
	if (typeof value === 'number') return Number.isInteger(value) ? value : fallback
	if (typeof value !== 'string' || value.trim() === '') return fallback
	const parsed = Number(value)
	return Number.isInteger(parsed) ? parsed : fallback
}

/**
 * Read an on/off worker var, falling back to `fallback` when it is unset or unusable.
 *
 * Accepts the spellings an operator plausibly types — `on`/`off`, `true`/`false`,
 * `yes`/`no`, `1`/`0`, in any case — plus a real boolean or number, since a var declared
 * in wrangler.jsonc `vars` keeps its JSON type while one set with `--var` is a string (see
 * `intVar`). Anything else (an empty string, `enabled`, a typo) is treated as unset rather
 * than read as true or false: a switch that guards something sensitive must not flip on a
 * misspelling, so the documented default is the safe failure.
 */
export function flagVar(value: unknown, fallback: boolean): boolean {
	if (typeof value === 'boolean') return value
	if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : fallback
	if (typeof value !== 'string') return fallback
	switch (value.trim().toLowerCase()) {
		case 'on':
		case 'true':
		case 'yes':
		case '1':
			return true
		case 'off':
		case 'false':
		case 'no':
		case '0':
			return false
		default:
			return fallback
	}
}
