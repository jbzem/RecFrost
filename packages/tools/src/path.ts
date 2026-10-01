import * as find from 'empathic/find'
import * as pkg from 'empathic/package'
import memoizeOne from 'memoize-one'
import { z } from 'zod'

export const getRepoRoot = memoizeOne(() => {
	// empathic's result can use either separator; normalize to the platform
	// native form so every consumer (zx's `cd()`, `process.cwd() === root`
	// comparisons, `path.join`) sees one consistent style. A mixed-style root
	// is what dies: zx resolves a POSIX `cd()` target against a Windows cwd
	// with ENOENT, and a forward-slash root never `===` a Windows cwd.
	const found = path.normalize(find.up('pnpm-lock.yaml') ?? '')
	const pnpmLock = z
		.string()
		.trim()
		.endsWith(`${path.sep}pnpm-lock.yaml`)
		.refine((s) => path.isAbsolute(s), {
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
