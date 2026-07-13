// One-time secret handoff for the post-create reveal screen (PLAN §16.8).
//
// THE PROBLEM. §16.8 pins the create flow as server-first with FULL progressive
// enhancement: the form action mints the key and REDIRECTS to the reveal screen,
// working with JS disabled. A redirect is a fresh GET, so the plaintext — which
// the plugin hands back exactly once and can never re-derive (it is hashed at
// rest, §16.1) — has to survive one hop with no client-side state to hold it.
//
// THE CHOICE. A short-lived, **httpOnly** flash cookie, consumed (deleted) by the
// reveal route's `load` in the SAME response that renders it. Rejected
// alternatives: the URL/query string (secrets leak into history, logs, referrers),
// and a server-side stash table (a new table + TTL sweeper to hold a value for two
// seconds — and it would persist the plaintext, which is precisely what §16.1
// avoids). httpOnly means no script can read it, `sameSite: 'lax'` means it rides
// only same-site navigations, and the tight `path` keeps it off every other route.
//
// A refresh of the reveal screen therefore finds NO cookie and bounces back to
// Settings — which is not a bug but the feature: shown once, truthfully.

import type { Cookies } from '@sveltejs/kit';
import type { ApiScope } from './api/scope';

/** The flash cookie's name. */
export const API_KEY_REVEAL_COOKIE = 'pwm_api_key_reveal';

/**
 * Scoped to the api-keys subtree — the browser then sends it on nothing else
 * (not `/api/v1`, not the group pages), which is the smallest exposure that still
 * reaches `/settings/api-keys/created`.
 */
export const API_KEY_REVEAL_COOKIE_PATH = '/settings/api-keys';

/**
 * 5 minutes. Long enough for a slow redirect/back-forward, short enough that an
 * abandoned tab isn't holding a live secret. The cookie is normally deleted on
 * first read anyway; this is the backstop for the case where the reveal screen is
 * never reached.
 */
export const API_KEY_REVEAL_MAX_AGE_SECONDS = 5 * 60;

/** What the reveal screen needs. `key` is THE SECRET — it exists only in-flight. */
export interface ApiKeyReveal {
	id: string;
	name: string | null;
	scope: ApiScope;
	start: string | null;
	expiresAt: string | null;
	key: string;
}

/**
 * Stash the freshly-minted key for the redirect. `httpOnly` + `sameSite: 'lax'`
 * + a tight path (see the header). `secure` follows the request scheme, so it is
 * always on in production and still works on plain-HTTP localhost.
 */
export function setApiKeyReveal(cookies: Cookies, reveal: ApiKeyReveal): void {
	cookies.set(API_KEY_REVEAL_COOKIE, JSON.stringify(reveal), {
		path: API_KEY_REVEAL_COOKIE_PATH,
		httpOnly: true,
		sameSite: 'lax',
		maxAge: API_KEY_REVEAL_MAX_AGE_SECONDS
	});
}

/**
 * Read the stashed key AND delete the cookie — one call, so a caller cannot read
 * it without also consuming it. That "exactly once" property is what the reveal
 * screen's "you won't see this again" warning promises, enforced in code rather
 * than by convention.
 *
 * Returns `null` when the cookie is absent or unparseable/malformed (a tampered or
 * truncated value is treated as absent, never trusted) — the caller then bounces
 * back to Settings.
 */
export function takeApiKeyReveal(cookies: Cookies): ApiKeyReveal | null {
	const raw = cookies.get(API_KEY_REVEAL_COOKIE);
	// Always clear, even on a malformed value — a cookie we won't use must not
	// linger in the browser holding a secret.
	cookies.delete(API_KEY_REVEAL_COOKIE, { path: API_KEY_REVEAL_COOKIE_PATH });
	if (!raw) return null;

	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return null;
		const candidate = parsed as Partial<ApiKeyReveal>;
		// The secret and its id are the only load-bearing fields; without them there
		// is nothing to reveal.
		if (typeof candidate.id !== 'string' || typeof candidate.key !== 'string') return null;
		if (candidate.scope !== 'read' && candidate.scope !== 'write') return null;
		return {
			id: candidate.id,
			name: typeof candidate.name === 'string' ? candidate.name : null,
			scope: candidate.scope,
			start: typeof candidate.start === 'string' ? candidate.start : null,
			expiresAt: typeof candidate.expiresAt === 'string' ? candidate.expiresAt : null,
			key: candidate.key
		};
	} catch {
		return null;
	}
}
