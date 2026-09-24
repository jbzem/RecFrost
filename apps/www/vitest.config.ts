import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: `${__dirname}/wrangler.jsonc` },
			miniflare: {
				// Stands in for the `auth` service binding wrangler.jsonc declares — the real
				// worker isn't part of this project's test run, and without an override the
				// runtime refuses to start ("no such service is defined"). It echoes the
				// forwarded `cf-connecting-ip` back so a test can assert the browser's IP
				// actually survives the hop (see src/upstream.ts `postAuthForm`); every other
				// auth call in the tests fails before reaching it.
				serviceBindings: {
					AUTH: (request: Request) =>
						new Response(
							JSON.stringify({
								error: 'invalid_grant',
								error_description: request.headers.get('cf-connecting-ip') ?? 'no ip',
							}),
							{ status: 400, headers: { 'content-type': 'application/json' } }
						),
				},
				bindings: {
					ENVIRONMENT: 'VITEST',
					// The Turnstile keypair is NOT bound here: both keys come from the Secrets
					// Store now, and the tests seed the local store with the test pair (see
					// src/test/integration/api.test.ts). A plain binding of the same name would
					// shadow the store binding with a string.
				},
				// The worker's RECFLARE_NOTIFICATIONS_HUB binding points at the `notify`
				// worker's DO (script_name: "notify"), which isn't part of this isolated test —
				// without an override the runtime refuses to start, exactly as it does for the
				// AUTH service binding above. The same stub the `api` worker's tests use: it
				// records each send so a test can assert the ModerationKick frame a ban pushed,
				// and answers a fetch with it (DELETE resets).
				workers: [
					{
						name: 'notify',
						modules: true,
						compatibilityDate: '2026-06-16',
						compatibilityFlags: ['nodejs_compat'],
						durableObjects: { RECFLARE_NOTIFICATIONS_HUB: 'NotificationsHub' },
						script: `
							import { DurableObject } from 'cloudflare:workers'
							export class NotificationsHub extends DurableObject {
								sent = []
								async notifyPlayer(playerId, notificationType, data) {
									this.sent.push({ playerId, notificationType, data })
									return { delivered: 0, queued: true }
								}
								async notifyPlayerEphemeral(playerId, notificationType, data) {
									this.sent.push({ playerId, ephemeral: true, notificationType, data })
									return { delivered: 0 }
								}
								async notifyPlayersEphemeral(playerIds, notificationType, data) {
									this.sent.push({ playerIds, ephemeral: true, notificationType, data })
									return { delivered: 0 }
								}
								async broadcast() { return { delivered: 0 } }
								async fetch(request) {
									if (request.method === 'DELETE') {
										this.sent = []
										return new Response(null, { status: 204 })
									}
									if (new URL(request.url).pathname === '/all') return Response.json(this.sent)
									return Response.json(this.sent.at(-1) ?? null)
								}
							}
							export default { fetch() { return new Response('ok') } }
						`,
					},
				],
			},
		}),
	],
})
