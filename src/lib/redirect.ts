// Shared, SAFE post-auth redirect sanitizer (task 3.7, PLAN §6.2).
//
// The accept flow (`/invite/[token]`) sends an anonymous invitee through
// `/login?redirectTo=…` / `/register?redirectTo=…` so they return to the invite
// after authenticating. That `redirectTo` is ATTACKER-CONTROLLED (it rides in a
// URL the invitee can edit / be tricked into following), so before we ever feed
// it into a `redirect(303, …)` or client `goto(…)` we MUST prove it's a local,
// same-origin PATH — never an open redirect to another site or a `javascript:`
// scheme.
//
// This module is PURE and has no SvelteKit/server imports so it's trivially
// unit-testable and importable from both `+page.server.ts` and `+page.svelte`.

/**
 * Return `value` only if it is a safe LOCAL path to redirect to; otherwise
 * `null`. The caller substitutes its own default for `null` (e.g. `?? '/'`).
 *
 * Accepted: a string that starts with a single `/` (a same-origin absolute
 * path), e.g. `/groups`, `/invite/abc`.
 *
 * Rejected (→ `null`):
 *   - non-strings (`undefined`, `null`, numbers) — defensive, the param often
 *     comes from `searchParams.get()` which is `string | null`.
 *   - the empty string.
 *   - protocol-relative URLs `//evil.com` and the backslash variant `/\evil`
 *     (browsers treat `/\` like `//`) — these would navigate off-origin.
 *   - anything with a scheme (`https://…`, `javascript:…`) — i.e. not starting
 *     with `/` at all.
 */
export function safeRedirectTo(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	if (value.length === 0) return null;
	// Must be an absolute path on THIS origin.
	if (!value.startsWith('/')) return null;
	// Reject protocol-relative (`//host`) and its backslash trick (`/\host`),
	// which browsers normalize to an off-origin navigation.
	if (value.startsWith('//') || value.startsWith('/\\')) return null;
	return value;
}
