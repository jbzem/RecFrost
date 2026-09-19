import * as find from 'empathic/find'
import * as pkg from 'empathic/package'
import memoizeOne from 'memoize-one'
import { z } from 'zod'

export const getRepoRoot = memoizeOne(() => {
	// Normalize Windows separators first: `find.up` returns a drive-letter path
	// (`C:\…`) there, which the POSIX-anchored validation below would reject —
	// without this no `runx` command runs on Windows at all. `path` here is the
	// platform module, which accepts forward slashes on every OS.
	const found = z
		.string()
		.trim()
		.parse(find.up('pnpm-lock.yaml'))
		.replaceAll('\\', '/')
	const pnpmLock = z.string().endsWith('/pnpm-lock.yaml').parse(found)
	return path.dirname(pnpmLock)
})

/**
 * Get the package name of the nearest package.json
 */
export const getPackageName = memoizeOne(async (): Promise<string> => {
	const pkgJsonPath = pkg.up()
	if (!pkgJsonPath) {
		throw new Error(`unable to locate package.json from ${process.cwd()}`)
	}
	const pkgJson = z.object({ name: z.string() }).safeParse(await fs.readJson(pkgJsonPath))
	if (!pkgJson.success) {
		throw new Error(`unable to parse package.json: ${pkgJsonPath}`)
	}
	return pkgJson.data.name
})
