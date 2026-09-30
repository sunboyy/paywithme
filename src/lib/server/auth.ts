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

import { betterAuth, type AuthContext, type BetterAuthRateLimitOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { jwt, magicLink } from 'better-auth/plugins';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { passkey } from '@better-auth/passkey';
import { apiKey } from '@better-auth/api-key';
import { mcp } from '@better-auth/mcp';
import { getRequestEvent } from '$app/server';
import { building } from '$app/environment';
import { env } from '$env/dynamic/private';
import { db } from './db';
import { sendMagicLinkEmail } from './email';
import { OAUTH_SCOPES } from './api/scope';

// rpName is the constant the OS passkey prompt shows (PLAN §5.2) — not an env var.
const RP_NAME = 'Pay with me';

// API-key prefixes (PLAN §16.1). These are OUR env-scoping policy, not a plugin
// freebie: keys minted against a live database carry `pwm_live_`, everything else
// (dev/test/preview) carries `pwm_test_`, so a test key is never mistaken for a
// production credential. The prefix is baked into the plaintext key and its stored
// `start`, so the display surface stays prefix-agnostic (it renders whatever
// `start` a key carries). The trailing underscore is the plugin's recommended
// convention for making a prefix identifiable.
const API_KEY_PREFIX_LIVE = 'pwm_live_';
const API_KEY_PREFIX_TEST = 'pwm_test_';

// ── MCP OAuth connector (ADR-0010, ADR-0018) ─────────────────────────────────
// Where the AS sends an already-logged-in resource-owner to make the conscious
// read/write (can-it-move-money) consent choice. The plugin redirects here with
// the pending authorization request as SIGNED query params (`client_id`, `scope`,
// …, `sig`), which the page posts back as `oauth_query`. It MUST match the
// on-disk route `src/routes/oauth/consent` (its `page.server.test.ts` asserts the
// two can't drift), so the route reads the value from HERE.
export const OAUTH_CONSENT_PATH = '/oauth/consent';

// Where the AS sends an UNauthenticated resource-owner to establish a session
// before authorization/consent. The page then resumes the authorization.
const OAUTH_LOGIN_PATH = '/oauth/login';

// The base OIDC scopes the provider supports alongside our own `read`/`write`.
// `scopes` REPLACES the plugin default, so they are listed explicitly.
// `offline_access` is what lets a connector get a refresh token.
const OIDC_BASE_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const;

/** Every scope the authorization server grants and advertises. */
export const OAUTH_SUPPORTED_SCOPES = [...OIDC_BASE_SCOPES, ...OAUTH_SCOPES];

/** The MCP endpoint path. Its absolute URL is the OAuth protected resource. */
const MCP_PATH = '/mcp';

// Used when BETTER_AUTH_URL is unset (dev/test only; production fails fast in
// `resolveAuthEnv`). `mcp()` validates `resource` at CONSTRUCTION, so it needs
// some absolute URL even at build time.
const DEV_FALLBACK_ORIGIN = 'http://localhost:5173';

/**
 * Make the OAuth provider's startup resource seed non-fatal.
 *
 * The provider inserts the `/mcp` row into `oauth_resource` inside its `init`,
 * which runs while better-auth builds `$context`: ONE promise, created when this
 * module is imported and shared by every request for the life of the process. If
 * that insert fails (no database during `vite build` or unit tests, or a
 * transient Neon error on a cold start), `$context` rejects and every auth
 * request on the instance fails until it is recycled.
 *
 * The provider already seeds lazily: every resource lookup first runs the same
 * seed (`seedResourcesOnce`), and when the startup seed reports a missing table it
 * simply defers to that path. So during `init` only, a failed `oauthResource`
 * read/write is logged and re-raised as a missing-table error, which takes the
 * deferral path. After `init`, the adapter is untouched and errors propagate as
 * usual. `auth.test.ts` asserts `$context` resolves with no database, so a
 * provider upgrade that changes this behaviour fails loudly.
 */
function deferResourceSeedFailure<P extends { init?: (ctx: AuthContext) => unknown }>(
	plugin: P
): P {
	const init = plugin.init;
	if (!init) return plugin;
	const deferred = (err: unknown): never => {
		console.warn('[auth] OAuth resource seed deferred to first use:', err);
		throw new Error('relation "oauth_resource" does not exist (seed deferred to first use)');
	};
	return {
		...plugin,
		init: (ctx: AuthContext) => {
			const adapter = new Proxy(ctx.adapter, {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if ((prop !== 'findOne' && prop !== 'create') || typeof value !== 'function') {
						return value;
					}
					return async (args: { model: string }) => {
						if (args.model !== 'oauthResource') return value.call(target, args);
						try {
							return await value.call(target, args);
						} catch (err) {
							return deferred(err);
						}
					};
				}
			});
			return init(
				new Proxy(ctx, {
					get: (target, prop, receiver) =>
						prop === 'adapter' ? adapter : Reflect.get(target, prop, receiver)
				})
			);
		}
	};
}

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
	VERCEL_ENV?: string;
	VERCEL_BRANCH_URL?: string;
	VERCEL_URL?: string;
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
 * A Vercel preview is served from its own `*.vercel.app` host, so the production
 * origin values can't work there. On previews, the stable per-branch URL replaces
 * them: passkeys and magic links are bound to it, and the per-deployment URL is
 * trusted too so forms posted from it pass the origin check.
 */
function withVercelPreviewOrigin(env: AuthEnvInput): AuthEnvInput {
	if (env.VERCEL_ENV !== 'preview') return env;
	const branchHost = env.VERCEL_BRANCH_URL?.trim();
	if (!branchHost) {
		throw new Error(
			'Auth misconfiguration: VERCEL_BRANCH_URL is missing on a Vercel preview. Enable System Environment Variables in the Vercel project, and deploy previews from a Git branch.'
		);
	}

	const branchOrigin = `https://${branchHost}`;
	const deploymentHost = env.VERCEL_URL?.trim();
	const origins = deploymentHost ? [branchOrigin, `https://${deploymentHost}`] : [branchOrigin];
	return {
		...env,
		BETTER_AUTH_URL: branchOrigin,
		AUTH_RP_ID: branchHost,
		AUTH_TRUSTED_ORIGINS: origins.join(',')
	};
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
	env: rawEnv,
	isProduction
}: {
	env: AuthEnvInput;
	isProduction: boolean;
}): ResolvedAuthEnv {
	const authEnv = withVercelPreviewOrigin(rawEnv);
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
 * Resolve the env-scoped API-key prefix (PLAN §16.1).
 *
 * PURE and unit-testable — takes the same `isProduction` flag `resolveAuthEnv`
 * uses (rather than reading global state) so it can be exercised without building
 * `auth`. Production keys get `pwm_live_`; dev/test/preview get `pwm_test_`. This
 * feeds the plugin's `defaultPrefix`, which stamps the prefix into every minted
 * key's plaintext and its stored `start`.
 */
export function resolveApiKeyPrefix({ isProduction }: { isProduction: boolean }): string {
	return isProduction ? API_KEY_PREFIX_LIVE : API_KEY_PREFIX_TEST;
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
		AUTH_TRUSTED_ORIGINS: env.AUTH_TRUSTED_ORIGINS,
		VERCEL_ENV: env.VERCEL_ENV,
		VERCEL_BRANCH_URL: env.VERCEL_BRANCH_URL,
		VERCEL_URL: env.VERCEL_URL
	},
	isProduction: env.NODE_ENV === 'production' && !building
});

// The app's canonical origin. It is the OAuth ISSUER (so RFC 8414 discovery
// lives at the root `/.well-known/oauth-authorization-server`, not under
// `/api/auth`) and the base of the MCP resource identifier. Access tokens are
// JWTs with `iss` = this origin and `aud` = the resource; `/mcp` checks both.
const appOrigin = new URL(baseURL ?? DEV_FALLBACK_ORIGIN).origin;
export const OAUTH_ISSUER = appOrigin;
export const MCP_RESOURCE = `${appOrigin}${MCP_PATH}`;

// Env-scoped API-key prefix (PLAN §16.1): live keys carry `pwm_live_` and
// everything else carries `pwm_test_`. Vercel previews run with
// NODE_ENV=production, so they are excluded explicitly. Feeds the `apiKey`
// plugin's `defaultPrefix` below.
const apiKeyPrefix = resolveApiKeyPrefix({
	isProduction: env.NODE_ENV === 'production' && env.VERCEL_ENV !== 'preview' && !building
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
	// The `jwt` plugin's session→JWT endpoint. Nothing here uses it, so it is not
	// exposed.
	disabledPaths: ['/token'],
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
		// API-key plugin (PLAN §16.1). Registered BEFORE `sveltekitCookies` (which
		// stays last). It provides the server-side key API
		// (`auth.api.{createApiKey,verifyApiKey,getApiKey,updateApiKey,deleteApiKey,
		// listApiKeys,deleteAllExpiredApiKeys}`) that later tickets call from the
		// app's own routes — hashing at rest (SHA-256), one-time plaintext reveal on
		// create, a display `start` prefix, per-key expiry, `lastRequest`/
		// `requestCount`, `permissions`, and per-key rate-limit fields.
		//
		// `enableSessionForAPIKeys` stays OFF (the plugin flags it not-for-production):
		// the app resolves keys explicitly (§16.4) rather than having a valid key
		// mock a session. The plugin's own HTTP endpoints (`/api/auth/api-key/*`) are
		// NOT the public API.
		//
		// Coupling: the backing `api_key` table is HAND-AUTHORED in its own file
		// (`db/api-key-schema.ts`, exported under the adapter key `apikey`) by a
		// SEPARATE ticket (#13). Registering the plugin here is construction-time
		// only and does not touch the DB, so the config builds and the gate stays
		// green before that schema exists; any server API call that hits the store
		// will need the #13 table.
		apiKey({
			enableSessionForAPIKeys: false,
			// Env-scoped prefix policy (PLAN §16.1): `pwm_live_` in production,
			// `pwm_test_` everywhere else. The plugin stamps this into every minted
			// key's plaintext and its stored `start`, so the display surface stays
			// prefix-agnostic. See `resolveApiKeyPrefix` / `apiKeyPrefix` above.
			defaultPrefix: apiKeyPrefix,
			// TIER-1 rate-limit BACKSTOP (PLAN §16.7). These config-level defaults are
			// stamped onto EVERY key at creation (the plugin's `createApiKey` reads
			// `rateLimitMax ?? opts.rateLimit.maxRequests`, `rateLimitTimeWindow ??
			// opts.rateLimit.timeWindow`, `rateLimitEnabled ?? opts.rateLimit.enabled`),
			// so no per-key creation UX (#23) is needed to satisfy the "set on every
			// key" requirement. The plugin's built-in per-key limiter fires INSIDE the
			// `verifyApiKey` call the `/api/v1` guard already makes (`hooks.server.ts`).
			//
			// It is ONE combined counter per key (it can't split read/write), so it is
			// deliberately sized ABOVE the tier-2 burst (read 100/60s + write 20/60s):
			// a generous 150 req / 60s. Tier 2 (the primary, class-aware limiter in
			// `api/rate-limit.ts`) does the real per-class enforcement; this tier only
			// trips if tier 2 is bypassed or buggy. On a trip the plugin surfaces
			// `RATE_LIMITED`, which the guard maps to the 429 envelope (§16.7).
			rateLimit: {
				enabled: true,
				timeWindow: 60_000,
				maxRequests: 150
			}
		}),
		// Signs the connector's OAuth access tokens (ADR-0018) and serves the
		// public keys at `/api/auth/jwks`. Keys live in the `jwks` table.
		//
		// `issuer` is pinned to the app origin: see `OAUTH_ISSUER`. The plugin also
		// has a session→JWT feature, which this app does not use: the `set-auth-jwt`
		// response header is off here, and its `/token` endpoint is in
		// `disabledPaths` above.
		jwt({
			jwt: { issuer: OAUTH_ISSUER },
			disableSettingJwtHeader: true
		}),
		// OAuth 2.1 authorization server for the Claude.ai connector (ADR-0010,
		// ADR-0018). `@better-auth/mcp` is `@better-auth/oauth-provider` preset for
		// MCP: it binds every token to `resource` (the `/mcp` URL) and serves RFC
		// 9728 metadata. Endpoints live under `/api/auth/oauth2/*`.
		//
		// Client registration: Claude.ai registers itself through Dynamic Client
		// Registration (RFC 7591), unauthenticated, as a public PKCE client, so
		// both flags are on. This matches what the old `mcp` plugin did.
		//
		// `scopes` makes `read`/`write` GRANTABLE (`/oauth2/authorize` rejects any
		// other scope with `invalid_scope`), and `lib/server/mcp/auth.ts` maps a
		// granted `write` onto a write principal. Both read the SAME `OAUTH_SCOPES`
		// constant, so they can't drift. `advertisedMetadata` publishes the full set
		// in discovery, so a connector finds out that `read`/`write` exist.
		//
		// The tables are HAND-AUTHORED in `db/oauth-schema.ts`. The plugin seeds the
		// `/mcp` resource row at startup; `deferResourceSeedFailure` keeps a failed
		// seed from breaking auth (see there).
		deferResourceSeedFailure(
			mcp({
				loginPage: OAUTH_LOGIN_PATH,
				consentPage: OAUTH_CONSENT_PATH,
				resource: MCP_RESOURCE,
				scopes: OAUTH_SUPPORTED_SCOPES,
				advertisedMetadata: { scopes_supported: OAUTH_SUPPORTED_SCOPES },
				allowDynamicClientRegistration: true,
				allowUnauthenticatedClientRegistration: true
			})
		),
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
