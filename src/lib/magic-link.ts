// The magic-link `callbackURL`: our `/auth/magic-link` landing, carrying where to
// go next as `?redirectTo=`.
//
// better-auth decodes `callbackURL` one level too many: its verify endpoint runs
// `decodeURIComponent` on the query value, which the URL parser has already
// decoded. So a singly-encoded `redirectTo` arrives at the landing DECODED, and
// any `&` inside it splits it into separate params: `/oauth/login?a=1&b=2`
// reaches the landing as `redirectTo=/oauth/login?a=1`, and the OAuth connector
// flow loses its request. Encoding `redirectTo` twice cancels the extra decode.
// `magic-link.test.ts` replays better-auth's exact steps to pin this.

/** Build the magic-link `callbackURL` for an optional local `redirectTo` path. */
export function magicLinkCallbackURL(redirectTo: string | null): string {
	if (!redirectTo) return '/auth/magic-link';
	return '/auth/magic-link?redirectTo=' + encodeURIComponent(encodeURIComponent(redirectTo));
}
