import * as find from 'empathic/find'
import * as pkg from 'empathic/package'
import memoizeOne from 'memoize-one'
import { z } from 'zod'

export const getRepoRoot = memoizeOne(() => {
	// empathic returns a Windows path (backslashes) on win32, which fails the
	// POSIX validation below — normalize first. node accepts forward slashes
	// everywhere, so downstream joins are unaffected.
	const found = (find.up('pnpm-lock.yaml') ?? '').replace(/\\/g, '/')
	const pnpmLock = z
		.string()
		.trim()
		.endsWith('/pnpm-lock.yaml')
		.refine((s) => s.startsWith('/') || /^[A-Za-z]:\//.test(s), {
			message: 'expected an absolute path to pnpm-lock.yaml',
		})
		.parse(found)
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
