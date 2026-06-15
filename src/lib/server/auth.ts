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
//   - task 2.4: `hooks.server.ts` session resolution → `event.locals`.
//
// Session cookies (HTTP-only, Secure, SameSite=Lax — PLAN §5.7) are better-auth
// defaults, so we do not re-declare them here.

import { betterAuth, type BetterAuthRateLimitOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { passkey } from '@better-auth/passkey';
import { getRequestEvent } from '$app/server';
import { building } from '$app/environment';
import { env } from '$env/dynamic/private';
import { db } from './db';
import { sendMagicLinkEmail } from './email';

// rpName is the constant the OS passkey prompt shows (PLAN §5.2) — not an env var.
const RP_NAME = 'Pay with me';

// Magic-link token lifetime. PLAN §5.3 wants tokens "single-use, short-lived";
// each token is also consumed atomically on first verification by the plugin.
// 10 minutes balances email-delivery latency against the short-lived goal.
const MAGIC_LINK_EXPIRES_IN_SECONDS = 60 * 10;

// ── Rate limiting (PLAN §12) ────────────────────────────────────────────────
// better-auth's built-in rate limiter keys each request on IP + request path
// (see `createRateLimitKey(ip, path)` in better-auth's api/rate-limiter), with
// default in-memory storage. We turn it on in EVERY environment (better-auth
// otherwise only enables it in production) so the policy is active and testable
// in dev/preview too, and we pin a tightened rule for the magic-link endpoints
// to blunt email bombing (PLAN §12).
//
// Global fallback bucket for every other auth endpoint: generous enough not to
// trip normal usage, low enough to cap abusive bursts from a single source.
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX = 60;

// Tightened magic-link policy. The SEND endpoint (`/sign-in/magic-link`) is the
// email-bombing surface, so it gets the strictest cap; VERIFY (`/magic-link/verify`)
// is the click target. We also throttle the passkey sign-in challenge, which is
// cheap and another credential-spray surface.
//
// IMPORTANT v1 limitation: better-auth keys rate limits on IP + path, NOT on the
// target email. So this throttles bombing from a single source/IP but does not,
// on its own, stop a distributed many-IP campaign against one mailbox. True
// per-email throttling across IPs is a documented v1 limitation, acceptable
// here because the send response is identical regardless of whether the account
// exists (tasks 2.5/2.7) — there is no enumeration signal to exploit, and the
// magic-link tokens are themselves single-use and short-lived (PLAN §5.3).
//
// customRules keys are matched by EXACT path (or `*` wildcard) against the
// normalized request path, so these must be the literal plugin endpoint paths.
const MAGIC_LINK_SEND_PATH = '/sign-in/magic-link';
const MAGIC_LINK_VERIFY_PATH = '/magic-link/verify';
const PASSKEY_SIGN_IN_PATH = '/passkey/verify-authentication';
const MAGIC_LINK_RATE_LIMIT = { window: 60, max: 5 } as const;
const PASSKEY_RATE_LIMIT = { window: 60, max: 10 } as const;

// Trusted client-IP header for rate-limit bucketing (PLAN §12 — production
// hardening for task 2.11).
//
// better-auth derives the rate-limit key from the client IP (see
// `getIp()` in better-auth/utils/get-request-ip), iterating
// `advanced.ipAddress.ipAddressHeaders` IN ORDER and taking the FIRST valid IP,
// read as `value.split(",")[0].trim()`. Its DEFAULT list is just
// `["x-forwarded-for"]`. On a platform that lets a client prepend its own
// entry, that first value is attacker-controlled, so an attacker could rotate it
// to mint unlimited fresh rate-limit buckets and slip past the magic-link cap.
//
// This app deploys on Vercel (`@sveltejs/adapter-vercel`, task 1.1). Per
// Vercel's request-headers docs:
//   - `x-real-ip` is SET BY VERCEL to the real client IP as a SINGLE value and
//     overwrites any client-supplied value — it is not spoofable.
//   - `x-forwarded-for` is also overwritten by Vercel to the public client IP
//     ("do not forward external IPs … to prevent IP spoofing"), BUT it may carry
//     extra entries when a proxy sits on top of Vercel.
// So we put the single-value, Vercel-guaranteed `x-real-ip` FIRST (the trusted
// header), with `x-forwarded-for` as a fallback. The first/trusted header is the
// non-spoofable one, which is what closes the bucket-evasion gap.
//
// Locally (dev/test) neither header is present, so better-auth falls back to a
// localhost bucket — this only changes/hardens production behaviour.
const IP_ADDRESS_HEADERS = ['x-real-ip', 'x-forwarded-for'] as const;

// Storage: POSTGRES-backed (production hardening from task 2.11). The default
// `storage: 'memory'` store is PER-INSTANCE: on Vercel's serverless/edge fleet
// each instance keeps its own counters, so the effective limit scales with the
// number of warm instances and a determined attacker can dodge it by spraying
// across instances. With `storage: 'database'` better-auth persists its
// per-(IP+path) counters in Postgres instead, so the limit is SHARED across all
// instances. The backing table is defined in `db/rate-limit-schema.ts` (a
// hand-authored `rateLimit` Drizzle export → the `rate_limit` SQL table); it
// lives outside the CLI-generated `auth-schema.ts` because `@better-auth/cli
// generate` cannot resolve the `$app/server` import the `sveltekitCookies`
// plugin pulls into this module. The drizzle adapter resolves the better-auth
// `rateLimit` model via `schema['rateLimit']` and increments `count` per request
// through its `incrementOne` support.
const rateLimit = {
	// Always on, in every environment (default is production-only).
	enabled: true,
	window: RATE_LIMIT_WINDOW_SECONDS,
	max: RATE_LIMIT_MAX,
	// Postgres-backed, shared across instances — see the note above. Counters live
	// in the `rate_limit` table (db/rate-limit-schema.ts).
	storage: 'database',
	customRules: {
		[MAGIC_LINK_SEND_PATH]: MAGIC_LINK_RATE_LIMIT,
		[MAGIC_LINK_VERIFY_PATH]: MAGIC_LINK_RATE_LIMIT,
		[PASSKEY_SIGN_IN_PATH]: PASSKEY_RATE_LIMIT
	}
} satisfies BetterAuthRateLimitOptions;

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
 * The minimal slice of env vars `resolveAuthEnv` reads. Kept as an explicit
 * shape so the helper stays a PURE function of its inputs — callable in tests
 * with a fake object instead of mutating the real `process.env`/`$env`.
 */
export interface AuthEnvInput {
	BETTER_AUTH_URL?: string;
	BETTER_AUTH_SECRET?: string;
	AUTH_RP_ID?: string;
	AUTH_TRUSTED_ORIGINS?: string;
}

/** Fully-resolved auth env, ready to wire straight into `betterAuth(...)`. */
export interface ResolvedAuthEnv {
	/** better-auth `baseURL` and the WebAuthn `origin` (same canonical origin). */
	baseURL: string | undefined;
	/** WebAuthn relying-party id (host, no scheme/port). */
	rpID: string;
	/** WebAuthn `origin` passed to the passkey plugin. */
	origin: string | null;
	/** Parsed `AUTH_TRUSTED_ORIGINS`. */
	trustedOrigins: string[];
	/** Session-signing secret (better-auth requires one in production). */
	secret: string | undefined;
}

/**
 * Resolve the auth config strictly per environment (PLAN §12).
 *
 * PURE and unit-testable: it takes the env slice + an `isProduction` flag and
 * never reads global state, so tests pass a fake `env` rather than mutating
 * `process.env`.
 *
 * Production (`isProduction === true`) is FAIL-FAST: a misconfigured prod auth
 * (wrong/missing rpID, origin, trusted origins, or secret) is more dangerous
 * than a crash, so every required value MUST be present or we throw. The error
 * lists only the MISSING VARIABLE NAMES — never any value — so nothing secret
 * leaks into logs.
 *
 * Dev/test (`isProduction === false`) keeps the lenient fallbacks (rpID →
 * `localhost`, baseURL/origin may be undefined, trustedOrigins may be empty) so
 * local dev and the gate work against the committed `.env.example` shape and
 * importing this module never throws when NODE_ENV is `test`/undefined.
 */
export function resolveAuthEnv({
	env: authEnv,
	isProduction
}: {
	env: AuthEnvInput;
	isProduction: boolean;
}): ResolvedAuthEnv {
	const baseURL = authEnv.BETTER_AUTH_URL?.trim() || undefined;
	const secret = authEnv.BETTER_AUTH_SECRET?.trim() || undefined;
	const rpIDFromEnv = authEnv.AUTH_RP_ID?.trim() || undefined;
	const trustedOrigins = parseTrustedOrigins(authEnv.AUTH_TRUSTED_ORIGINS);

	if (isProduction) {
		// Collect ALL missing required vars so one throw names everything to fix.
		const missing: string[] = [];
		if (!baseURL) missing.push('BETTER_AUTH_URL');
		if (!secret) missing.push('BETTER_AUTH_SECRET');
		if (!rpIDFromEnv) missing.push('AUTH_RP_ID');
		if (trustedOrigins.length === 0) missing.push('AUTH_TRUSTED_ORIGINS');
		if (missing.length > 0) {
			// Names only — never the values — so no secret leaks into the message.
			throw new Error(
				`Auth misconfiguration: the following environment variable(s) are required in production but are missing or empty: ${missing.join(
					', '
				)}.`
			);
		}
		return {
			baseURL,
			rpID: rpIDFromEnv as string,
			// WebAuthn origin = the app's canonical origin (BETTER_AUTH_URL).
			origin: baseURL as string,
			trustedOrigins,
			secret
		};
	}

	// Dev/test: lenient fallbacks so local dev and the gate keep working.
	return {
		baseURL,
		rpID: rpIDFromEnv ?? 'localhost',
		origin: baseURL ?? null,
		trustedOrigins,
		secret
	};
}

/**
 * `sendMagicLink` callback wired into the `magicLink` plugin below.
 *
 * Routes the single-use, short-lived link (PLAN §5.3) through the swappable
 * `lib/server/email` helper, which sends via the Mailgun HTTP API or, when
 * Mailgun is unconfigured, logs the link for local dev. Exported and used
 * directly as the plugin's callback so the email seam is a single source of
 * truth that cannot drift from what the plugin actually calls.
 */
export async function sendMagicLink({ email, url }: { email: string; url: string }): Promise<void> {
	// (PLAN §5.3 single-use/short-lived)
	await sendMagicLinkEmail({ to: email, url });
}

// Read config from env at runtime via $env/dynamic/private so `pnpm run build`
// (and the `@better-auth/cli generate` step) don't crash when these are absent.
// Names mirror `.env.example` exactly.
//
// `isProduction` is read from the RUNTIME env (`NODE_ENV`), consistent with the
// "read at runtime so build/CLI don't crash" approach above: under the dev/test
// gate NODE_ENV is `test`/undefined, so `resolveAuthEnv` takes the lenient path
// and importing this module never throws. The fail-fast prod validation fires
// when NODE_ENV === 'production' AND a required var is missing.
//
// We AND in `!building` so the fail-fast does not trip during `vite build`'s
// analyse/prerender phase (which runs under NODE_ENV=production but has no real
// env). `building` is true only while building/prerendering and false at real
// request time, so a misconfigured PRODUCTION SERVER still fails fast the moment
// the server process imports this module — exactly when we want the crash —
// while the build itself stays unblocked, matching the existing "build/CLI don't
// crash" contract for this module. (On a clean tree the build's separate
// `BetterAuthError: default secret` analyse message is unchanged by this task.)
const { baseURL, secret, rpID, origin, trustedOrigins } = resolveAuthEnv({
	env: {
		BETTER_AUTH_URL: env.BETTER_AUTH_URL,
		BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
		AUTH_RP_ID: env.AUTH_RP_ID,
		AUTH_TRUSTED_ORIGINS: env.AUTH_TRUSTED_ORIGINS
	},
	isProduction: env.NODE_ENV === 'production' && !building
});

export const auth = betterAuth({
	database: drizzleAdapter(db, { provider: 'pg' }),
	secret,
	baseURL,
	trustedOrigins,
	// Always-on, IP+path keyed rate limiting with a tightened magic-link rule to
	// blunt email bombing (PLAN §12). See the `rateLimit` definition above.
	rateLimit,
	// Trust the spoof-resistant, Vercel-set client-IP header FIRST so production
	// rate-limit buckets are keyed on the REAL client IP and can't be evaded by a
	// client-supplied `x-forwarded-for` (PLAN §12). See `IP_ADDRESS_HEADERS` above.
	advanced: {
		ipAddress: {
			ipAddressHeaders: [...IP_ADDRESS_HEADERS]
		}
	},
	// Passwordless: email/password and social providers are intentionally off
	// (PLAN §5.1). Email is verified implicitly by clicking the magic link.
	emailAndPassword: { enabled: false },
	plugins: [
		magicLink({
			// Single-use, short-lived tokens (PLAN §5.3).
			expiresIn: MAGIC_LINK_EXPIRES_IN_SECONDS,
			// Routes through the `lib/server/email` helper (Mailgun HTTP API, with a
			// local console fallback). See `sendMagicLink` above.
			sendMagicLink
		}),
		passkey({
			rpID,
			rpName: RP_NAME,
			// WebAuthn origin = the app's canonical origin (BETTER_AUTH_URL),
			// resolved strictly per environment by `resolveAuthEnv`.
			origin
		}),
		// MUST stay LAST in this array (better-auth requirement). This plugin runs
		// its cookie handler in an `after` hook, so every server-side `auth.api.*`
		// call (e.g. the logout `signOut` in task 2.10) routes its Set-Cookie
		// through SvelteKit's own cookie API via `getRequestEvent` — so cleared /
		// refreshed session cookies actually reach the browser. `getRequestEvent`
		// is only invoked at request time, never at construction, so importing it
		// here keeps module import side-effect free for `pnpm build` / the
		// `@better-auth/cli generate` step.
		sveltekitCookies(getRequestEvent)
	]
});

// Inferred instance type for downstream tasks (2.2 handler, 2.4 hooks) that need
// to reference the fully-typed auth instance, its `$Infer` session/user types, etc.
export type Auth = typeof auth;
