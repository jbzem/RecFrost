import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: `${__dirname}/wrangler.jsonc` },
			miniflare: {
				bindings: {
					ENVIRONMENT: 'VITEST',
					// Password (no-platform) signup is OFF by default, and most create_account tests
					// post no `platform` — they'd all test the closed door. The switch itself is
					// covered by a test that flips it off and back.
					PASSWORD_SIGNUP: 'on',
				},
			},
		}),
	],
})
