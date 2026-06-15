import { defineConfig, devices } from '@playwright/test';

// Playwright e2e harness (PLAN §13 "Testing Strategy" — E2E bullet).
// This task (1.12) only stands up the harness + a smoke test; the full passkey /
// magic-link / group-settle flows are added by later tasks (e.g. 2.12), which
// reuse the WebAuthn virtual-authenticator helper in `e2e/support/webauthn.ts`.
//
// Run by the FULL gate (`scripts/gate-full.sh`) at phase boundaries, NOT by the
// fast per-task gate. e2e specs live in `./e2e` so Vitest (which only includes
// `src/**`) never picks them up, and Playwright never picks up Vitest specs.
const PORT = 4173;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
	testDir: './e2e',
	// Fail the build on CI if `test.only` was left in the source.
	forbidOnly: !!process.env.CI,
	// Deterministic local runs; one retry on CI to absorb infra flakiness.
	retries: process.env.CI ? 1 : 0,
	// Capture a trace only when retrying a previously failed test.
	use: {
		baseURL,
		trace: 'on-first-retry'
	},
	// The virtual authenticator (CDP `WebAuthn` domain) is Chromium-only, so
	// Chromium is the must-have project. Other browsers can be added later.
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] }
		}
	],
	// Build a production bundle and serve it with the SvelteKit preview server —
	// the most CI-reliable target (preview mirrors prod more closely than dev).
	// Reuse an already-running server locally for fast iteration, never on CI.
	webServer: {
		command: `pnpm build && pnpm preview --port ${PORT}`,
		port: PORT,
		reuseExistingServer: !process.env.CI,
		timeout: 120 * 1000
	}
});
