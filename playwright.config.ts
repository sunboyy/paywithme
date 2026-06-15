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

// Auth env for the spawned `pnpm build && pnpm preview` process (task 2.12).
//
// WebAuthn pins its `origin` / rpID to `BETTER_AUTH_URL`, so it MUST match the
// preview server the e2e run hits (`http://localhost:4173`) — the dev `.env`
// points at :5173, which would make passkey register/assert fail. We override
// the four auth vars here so the passkey ceremonies run against the right
// origin. `localhost` over http is a WebAuthn secure-context exception, so no
// TLS is needed. `pnpm build` also requires a `BETTER_AUTH_SECRET` or it throws
// `BetterAuthError: default secret`, so we always provide one.
//
// The secret below is an OBVIOUS DUMMY for the local/CI e2e run only — never a
// real secret (real secrets stay in the git-ignored `.env`). If a
// `BETTER_AUTH_SECRET` is already in the environment we reuse it; otherwise the
// fixed test value is fine because this server is throwaway.
const TEST_AUTH_SECRET =
	process.env.BETTER_AUTH_SECRET ?? 'e2e-dummy-better-auth-secret-not-a-real-secret';

// The DB the preview server (and the test process) talk to. Defaults to the
// committed local-dev Postgres URL so the suite runs without a hand-set env.
const TEST_DATABASE_URL =
	process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/paywithme';
const TEST_DATABASE_URL_UNPOOLED = process.env.DATABASE_URL_UNPOOLED ?? TEST_DATABASE_URL;

// The test PROCESS (not just the preview server) needs `DATABASE_URL` to query
// the `verification` table for magic-link interception (see `e2e/support/db.ts`).
// Ensure it's present on `process.env` so the support helper can read it without
// a dotenv dependency.
process.env.DATABASE_URL = TEST_DATABASE_URL;

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
		// A cold run builds the production bundle first; give it headroom.
		timeout: 180 * 1000,
		// Override auth env so WebAuthn `origin`/rpID match the preview origin
		// (:4173, not the dev `.env`'s :5173) and the build has a secret. See the
		// notes at the top of this file.
		env: {
			BETTER_AUTH_URL: baseURL,
			AUTH_TRUSTED_ORIGINS: baseURL,
			AUTH_RP_ID: 'localhost',
			BETTER_AUTH_SECRET: TEST_AUTH_SECRET,
			DATABASE_URL: TEST_DATABASE_URL,
			DATABASE_URL_UNPOOLED: TEST_DATABASE_URL_UNPOOLED
		}
	}
});
