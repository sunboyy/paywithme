// better-auth server instance (PLAN §5.2).
//
// SCOPE (task 1.8): this is the MINIMAL passwordless better-auth instance needed
// for `@better-auth/cli generate` to emit the Drizzle schema for all five auth
// tables (user / session / account / verification / passkey) and to type-check.
// The full wiring lands in later Phase 2 tasks:
//   - real `sendMagicLink` via the Mailgun helper  → tasks 2.1 + 2.3
//   - the `/api/auth/[...all]` handler mount        → task 2.2
//   - `hooks.server.ts` session resolution          → task 2.4
//
// Passwordless only (PLAN §3 decision #8, §5.2):
//   - `emailAndPassword` is NOT enabled; no social providers.
//   - `magicLink` plugin (email) — the `verification` table backs its tokens.
//   - `passkey` plugin — emits the `passkey` table (WebAuthn / FIDO2).
//
// better-auth owns its auth tables via the Drizzle adapter; the generated schema
// lives in `./db/auth-schema.ts` and is re-exported from `./db/schema.ts` so
// drizzle-kit picks the tables up.

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { env } from '$env/dynamic/private';
import { db } from './db';

// rpName is the constant the OS passkey prompt shows (PLAN §5.2) — not an env var.
const RP_NAME = 'Pay with me';

// Read config from env at runtime via $env/dynamic/private so `pnpm run build`
// (and the CLI generate step) don't crash when these are absent. The values do
// not affect the generated schema. Names mirror `.env.example`.
const baseURL = env.BETTER_AUTH_URL;
const secret = env.BETTER_AUTH_SECRET;
const rpID = env.AUTH_RP_ID ?? 'localhost';
const trustedOrigins = (env.AUTH_TRUSTED_ORIGINS ?? '')
	.split(',')
	.map((o) => o.trim())
	.filter(Boolean);

export const auth = betterAuth({
	database: drizzleAdapter(db, { provider: 'pg' }),
	secret,
	baseURL,
	trustedOrigins,
	// Passwordless: email/password and social providers are intentionally off.
	emailAndPassword: { enabled: false },
	plugins: [
		magicLink({
			// TODO(2.3): wire Mailgun email helper. Placeholder no-op so the config
			// type-checks and the CLI can generate the schema for task 1.8.
			sendMagicLink: async ({ email, url }) => {
				console.log(`[auth] (placeholder) magic link for ${email}: ${url}`);
			}
		}),
		passkey({
			rpID,
			rpName: RP_NAME,
			// WebAuthn origin = the app's canonical origin (BETTER_AUTH_URL).
			origin: baseURL ?? null
		})
	]
});
