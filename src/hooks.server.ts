// Server hooks (PLAN §5.7, §16.3).
//
// Two composed `handle` functions run per request via SvelteKit's `sequence()`:
//
//   handle = sequence(resolveSession, apiV1Guard)
//
//   1. `resolveSession` — resolves the better-auth COOKIE session once and
//      attaches `{ user, session }` to `event.locals` for browser (HTML) routes.
//      For `/api/v1/*` it SKIPS the cookie `getSession` entirely (agents send no
//      cookie — PLAN §16.3) and leaves the session locals null.
//   2. `apiV1Guard` — the `/api/v1/*` AUTHENTICATION gate (PLAN §16.3). For those
//      requests it extracts the `Authorization: Bearer <key>`, verifies it with
//      `auth.api.verifyApiKey`, and either short-circuits a generic 401 or
//      attaches the resolved principal to `event.locals.apiKey`. Every non-api
//      request passes straight through untouched.
//
// `resolveSession` RESOLVES and ATTACHES the cookie session — it never blocks;
// route protection (redirects) for browser routes belongs to individual routes.
// `apiV1Guard` is the ONLY blocking step, and only for `/api/v1/*`: authentication
// (401) is cross-cutting here; authorization (403 scope) is per-route in the
// handler (the §16.2 write-guard — a LATER ticket), not this hook.
//
// We use the plain `auth.api.getSession({ headers })` / `auth.api.verifyApiKey`
// server APIs rather than better-auth's `svelteKitHandler` mounting helper: that
// helper mounts the auth request handler (done by the `/api/auth/[...all]`
// route), whereas here we only READ the session / VERIFY a key.

import { auth } from '$lib/server/auth';
import { extractBearerKey, verifyBearerKey } from '$lib/server/api/verify';
import { apiErrorEnvelope, rateLimited } from '$lib/server/api/errors';
import { json, type Handle, type HandleServerError } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';

// The public API version prefix (PLAN §16.3). A request is an API-v1 request when
// its path is exactly `/api/v1` or lives under `/api/v1/…`. The trailing-slash
// check keeps unrelated paths like `/api/v1beta` from matching.
const API_V1_PREFIX = '/api/v1';

/** True for `/api/v1` and any `/api/v1/<resource>` path; false for everything else. */
function isApiV1Request(pathname: string): boolean {
	return pathname === API_V1_PREFIX || pathname.startsWith(`${API_V1_PREFIX}/`);
}

/**
 * The single generic 401 envelope for the `/api/v1` auth gate (PLAN §16.5).
 *
 * EVERY authentication failure — missing header, malformed header, and ALL
 * non-rate-limit `verifyApiKey` outcomes (`INVALID_API_KEY`, `KEY_DISABLED`,
 * `KEY_EXPIRED`, `KEY_NOT_FOUND`) — collapses to this one code/message so the
 * response carries no enumeration signal. The plugin's internal error code is
 * never forwarded. JSON, HTTP 401. (The shared envelope helper is #15; this
 * inline shape is intentionally minimal and #15 will generalize it.)
 */
function unauthorized(): Response {
	return json(
		{ error: { code: 'unauthorized', message: 'Authentication required.' } },
		{ status: 401 }
	);
}

// TIER-1 backstop limits (PLAN §16.7). The plugin's built-in per-key counter is a
// single COMBINED bucket (it can't split read/write), configured at 150 req / 60s
// in `auth.ts`. When it trips, `verifyApiKey` returns `code: 'RATE_LIMITED'` — the
// ONE failure code the guard does NOT collapse into the generic 401 (§16.7).
const TIER1_LIMIT = 150;
const TIER1_WINDOW_SECONDS = 60;

/**
 * Map the plugin's internal `RATE_LIMITED` (tier 1) onto the SAME 429 envelope the
 * tier-2 route limiter emits (PLAN §16.7): `{ scope: 'key', limit, windowSeconds,
 * retryAfterSeconds }` plus a `Retry-After` header. `verifyBearerKey` surfaces the
 * plugin's remaining budget in MILLISECONDS; we `Math.ceil` it to whole seconds for
 * both the header and the body. The tier-1 counter is COMBINED (not per-class), so
 * the scope is `'key'`.
 */
function tier1RateLimited(tryAgainInMs: number): Response {
	const retryAfterSeconds = Math.ceil(tryAgainInMs / 1000);
	return rateLimited(
		'Rate limit exceeded.',
		{
			scope: 'key',
			limit: TIER1_LIMIT,
			windowSeconds: TIER1_WINDOW_SECONDS,
			retryAfterSeconds
		},
		retryAfterSeconds
	);
}

/**
 * Resolve the better-auth COOKIE session and attach it to `event.locals`.
 *
 * Skips the cookie `getSession` entirely for `/api/v1/*` (agents send no cookie —
 * PLAN §16.3): those requests are authenticated by `apiV1Guard` via the Bearer
 * key instead. Always initializes `locals.apiKey` to `null` so the property is
 * defined for every route; `apiV1Guard` overwrites it on a verified key.
 */
const resolveSession: Handle = async ({ event, resolve }) => {
	// Default: no API principal. Populated only by `apiV1Guard` on a verified key.
	event.locals.apiKey = null;

	if (isApiV1Request(event.url.pathname)) {
		// No cookie session for the machine API — skip getSession outright.
		event.locals.user = null;
		event.locals.session = null;
		return resolve(event);
	}

	try {
		// `getSession` returns `{ session, user }` for an authenticated request and
		// `null` for an anonymous one (no/expired cookie) — the normal logged-out
		// path, NOT an error.
		const result = await auth.api.getSession({ headers: event.request.headers });
		event.locals.user = result?.user ?? null;
		event.locals.session = result?.session ?? null;
	} catch (error) {
		// Be robust: a transient failure resolving the session (e.g. a DB blip)
		// must not 500 the entire app. Treat the request as anonymous and continue;
		// downstream guards will redirect protected routes as usual.
		console.error('[hooks.server] failed to resolve session', error);
		event.locals.user = null;
		event.locals.session = null;
	}

	return resolve(event);
};

/**
 * `/api/v1/*` authentication gate (PLAN §16.3).
 *
 * Non-api requests pass straight through. For an api request it delegates to the
 * SHARED `verifyBearerKey` (`$lib/server/api/verify` — also used by the `/mcp`
 * Connector, ADR-0001) and short-circuits a generic 401 on any missing / malformed
 * / invalid / expired / revoked key. On success it attaches the resolved principal
 * to `event.locals.apiKey` and lets the route run.
 *
 * The TIER-1 rate limit (PLAN §16.7) is the ONE non-valid outcome NOT collapsed
 * into the generic 401: a client already HOLDS a valid key (rate limiting engages
 * only after a successful match), so surfacing 429 leaks no enumeration signal.
 */
const apiV1Guard: Handle = async ({ event, resolve }) => {
	if (!isApiV1Request(event.url.pathname)) {
		return resolve(event);
	}

	const verification = await verifyBearerKey(event.request.headers.get('authorization'));

	if (!verification.ok) {
		return verification.reason === 'rate_limited'
			? tier1RateLimited(verification.tryAgainInMs)
			: unauthorized();
	}

	// Verified. Attach the minimal principal (PLAN §16.4): the owning user + the
	// key's `permissions` (read by the §16.2 write-guard) + `name`, which is carried
	// ONLY as audit provenance (§16.2 — it lands in the audit row's summary suffix +
	// `metadata.keyName`), never as authority.
	event.locals.apiKey = verification.principal;

	return resolve(event);
};

// Composition seam (PLAN §16.3): cookie session resolution first, then the
// `/api/v1` auth gate. `sequence` runs them in order — `resolveSession`'s
// `resolve` is `apiV1Guard`, whose `resolve` is the real route handler — so a
// non-api request is byte-for-byte unaffected (the guard is a no-op for it).
export const handle: Handle = sequence(resolveSession, apiV1Guard);

/**
 * Uncaught-error normalizer (PLAN §16.3, §16.5).
 *
 * SvelteKit invokes `handleError` for any UNEXPECTED error thrown while serving a
 * request (an `error()`/`redirect()` control-flow throw is handled separately and
 * never reaches here). The object we return becomes `App.Error`, which SvelteKit
 * serializes as the JSON body of the error response for a data/JSON request.
 *
 *   - For `/api/v1/*` we return the stable `internal_error` 500 envelope
 *     (PLAN §16.5) and log the original error server-side — nothing internal
 *     leaks to the client.
 *   - Every other route returns `{ message }`, byte-identical to SvelteKit's
 *     default, so browser error behavior is unchanged.
 *
 * IMPORTANT — this hook is DEFENCE-IN-DEPTH, not the primary producer of the API
 * 500 envelope. SvelteKit only serializes this object as JSON when the request is
 * a data request OR content-negotiates to `application/json`; a client sending
 * `Accept: text/html` would instead get the static error page. The reliable
 * producer of the JSON envelope is the route-level seam
 * (`withApiErrorHandling` / `handleApiError` in `$lib/server/api/errors`), which
 * the resource handlers (#17–#19) wrap around their logic so the envelope is
 * emitted regardless of `Accept`. This hook catches anything that escapes that
 * seam (or an unwrapped route) and still shapes it as the envelope.
 */
export const handleError: HandleServerError = ({ error, event, message }) => {
	if (isApiV1Request(event.url.pathname)) {
		console.error('[hooks.server] uncaught /api/v1 error', error);
		return apiErrorEnvelope('internal_error');
	}
	// Non-api routes: preserve SvelteKit's default `{ message }` shape exactly.
	return { message };
};

// Exported for focused unit coverage of the guard in isolation. `extractBearerKey`
// now lives in `$lib/server/api/verify` (shared with the `/mcp` Connector) and is
// re-exported here so the hook's public surface is unchanged.
export { resolveSession, apiV1Guard, extractBearerKey };
