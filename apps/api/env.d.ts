// oxlint-disable @typescript-eslint/consistent-type-imports
type LocalEnv = import('./src/context').Env
type MainModule = typeof import('./src/api.app')

// Add Env to Cloudflare namespace so that we can access it via
// import { env } from 'cloudflare:workers'
declare namespace Cloudflare {
	interface Env extends LocalEnv {}
	interface GlobalProps {
		mainModule: MainModule
	}
}

// Vite serves a `?raw` import as the file's text. Used by the tests to read a data
// migration (0032, the custom-item price cap) as a STRING and run its UPDATE against the
// schema they build from SCHEMA_DDL, which the migration files never touch.
declare module '*.sql?raw' {
	const content: string
	export default content
}
