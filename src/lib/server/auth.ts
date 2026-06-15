// better-auth server instance (PLAN §5.1, §5.2, §5.7).
//
// This is the finalized, production-shaped passwordless better-auth config for
// Phase 2. It builds the `betterAuth({...})` instance reusing the lazy `db`
// client (so importing this module stays side-effect free at build/generate
// time) and registers exactly the two passwordless methods the product uses.
//
// Passwordless only (PLAN §5.1):
//   - `emailAndPassword` is NOT enabled; there are NO social providers.
//   - `magicLink` plugin (email) — the baseline credential for registration,
//     login, and recovery. Its single-use, short-lived tokens live in the
//     `verification` table (PLAN §5.3).
//   - `passkey` plugin — WebAuthn / FIDO2, enrolled after first login as the
//     fast day-to-day login (PLAN §5.4, §5.5). Backed by the `passkey` table.
//
// What still gets wired in by LATER Phase 2 tasks (seams marked inline below):
//   - task 2.2: the `/api/auth/[...all]/+server.ts` handler mount that serves
//     `auth.handler`.
//   - task 2.3: the real Mailgun email helper called from `sendMagicLink`
//     (currently a console.log placeholder — see TODO(2.3) below).
//   - task 2.4: `hooks.server.ts` session resolution → `event.locals`.
//
// Session cookies (HTTP-only, Secure, SameSite=Lax — PLAN §5.7) are better-auth
// defaults, so we do not re-declare them here.

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { env } from '$env/dynamic/private';
import { db } from './db';

// rpName is the constant the OS passkey prompt shows (PLAN §5.2) — not an env var.
const RP_NAME = 'Pay with me';

// Magic-link token lifetime. PLAN §5.3 wants tokens "single-use, short-lived";
// each token is also consumed atomically on first verification by the plugin.
// 10 minutes balances email-delivery latency against the short-lived goal.
const MAGIC_LINK_EXPIRES_IN_SECONDS = 60 * 10;

/**
 * Parse the comma-separated `AUTH_TRUSTED_ORIGINS` env value into the array
 * better-auth expects: trimmed, with empty entries dropped. Extracted as a pure
 * helper so the parsing contract is unit-testable without constructing `auth`.
 */
export function parseTrustedOrigins(raw: string | undefined): string[] {
	return (raw ?? '')
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean);
}

/**
 * Placeholder `sendMagicLink` callback wired into the `magicLink` plugin below.
 *
 * TODO(2.3): replace this placeholder with the Mailgun email helper in
 * `lib/server` (`sendMagicLink({ email, url })` → Mailgun HTTP API). The plugin
 * passes everything the helper needs (`email`, `url`, and the raw `token` if a
 * custom template wants it). For now it logs the link so local dev works before
 * email is wired up.
 *
 * Exported (and used directly as the plugin's callback) so the 2.3 seam is a
 * single source of truth: the test exercises this exact function rather than a
 * copy, so they cannot drift.
 */
export async function placeholderSendMagicLink({
	email,
	url
}: {
	email: string;
	url: string;
}): Promise<void> {
	console.log(`[auth] (placeholder) magic link for ${email}: ${url}`);
}

// Read config from env at runtime via $env/dynamic/private so `pnpm run build`
// (and the `@better-auth/cli generate` step) don't crash when these are absent.
// Names mirror `.env.example` exactly.
const baseURL = env.BETTER_AUTH_URL;
const secret = env.BETTER_AUTH_SECRET;
const rpID = env.AUTH_RP_ID ?? 'localhost';
const trustedOrigins = parseTrustedOrigins(env.AUTH_TRUSTED_ORIGINS);

export const auth = betterAuth({
	database: drizzleAdapter(db, { provider: 'pg' }),
	secret,
	baseURL,
	trustedOrigins,
	// Passwordless: email/password and social providers are intentionally off
	// (PLAN §5.1). Email is verified implicitly by clicking the magic link.
	emailAndPassword: { enabled: false },
	plugins: [
		magicLink({
			// Single-use, short-lived tokens (PLAN §5.3).
			expiresIn: MAGIC_LINK_EXPIRES_IN_SECONDS,
			// TODO(2.3): `placeholderSendMagicLink` (defined above) logs the link for
			// local dev and is replaced by the Mailgun email helper in task 2.3.
			sendMagicLink: placeholderSendMagicLink
		}),
		passkey({
			rpID,
			rpName: RP_NAME,
			// WebAuthn origin = the app's canonical origin (BETTER_AUTH_URL).
			origin: baseURL ?? null
		})
	]
});

// Inferred instance type for downstream tasks (2.2 handler, 2.4 hooks) that need
// to reference the fully-typed auth instance, its `$Infer` session/user types, etc.
export type Auth = typeof auth;
