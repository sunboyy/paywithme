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
import type { ApiKeyPrincipal } from '$lib/server/api/principal';
import { json, type Handle } from '@sveltejs/kit';
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
 * Extract the raw API key from an `Authorization: Bearer <key>` header.
 *
 * PURE and unit-testable. Returns the key with the `Bearer ` scheme stripped, or
 * `null` when the header is missing or malformed (no scheme, wrong scheme, or an
 * empty credential). The scheme match is case-insensitive per RFC 7235; the raw
 * key is passed straight to `verifyApiKey` (which reads no headers, so the
 * plugin's `x-api-key` default is bypassed — PLAN §16.3).
 */
export function extractBearerKey(authorization: string | null | undefined): string | null {
	if (!authorization) return null;
	const match = /^Bearer[ ]+(.+)$/i.exec(authorization.trim());
	if (!match) return null;
	const key = match[1].trim();
	return key.length > 0 ? key : null;
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
 * Non-api requests pass straight through. For an api request it extracts the
 * Bearer key, verifies it with `auth.api.verifyApiKey`, and short-circuits a
 * generic 401 on any missing/malformed/invalid/expired/revoked key. On success it
 * attaches the resolved principal to `event.locals.apiKey` and lets the route run.
 */
const apiV1Guard: Handle = async ({ event, resolve }) => {
	if (!isApiV1Request(event.url.pathname)) {
		return resolve(event);
	}

	const key = extractBearerKey(event.request.headers.get('authorization'));
	// Missing / malformed header → generic 401 (no distinct code — PLAN §16.5).
	if (!key) {
		return unauthorized();
	}

	let result: Awaited<ReturnType<typeof auth.api.verifyApiKey>>;
	try {
		// `verifyApiKey` reads no headers, so passing the raw key bypasses the
		// plugin's `x-api-key` default (PLAN §16.3).
		result = await auth.api.verifyApiKey({ body: { key } });
	} catch (error) {
		// A thrown verify (e.g. a DB blip) is treated as an auth failure, not a 500 —
		// same generic 401, no internal detail leaked.
		console.error('[hooks.server] verifyApiKey threw', error);
		return unauthorized();
	}

	// Any invalid/expired/revoked/unknown key → the SAME generic 401. The plugin's
	// internal `result.error.code` is deliberately never forwarded (no enumeration).
	if (!result.valid || !result.key) {
		return unauthorized();
	}

	// Verified. Attach the minimal principal (PLAN §16.4). The plugin stores the
	// owning user under `referenceId`; surface it as `userId`. `permissions` is the
	// key's scope, read by the §16.2 per-route write-guard (a LATER ticket).
	const principal: ApiKeyPrincipal = {
		keyId: result.key.id,
		userId: result.key.referenceId,
		permissions: result.key.permissions ?? null
	};
	event.locals.apiKey = principal;

	return resolve(event);
};

// Composition seam (PLAN §16.3): cookie session resolution first, then the
// `/api/v1` auth gate. `sequence` runs them in order — `resolveSession`'s
// `resolve` is `apiV1Guard`, whose `resolve` is the real route handler — so a
// non-api request is byte-for-byte unaffected (the guard is a no-op for it).
export const handle: Handle = sequence(resolveSession, apiV1Guard);

// Exported for focused unit coverage of the guard in isolation.
export { resolveSession, apiV1Guard };
