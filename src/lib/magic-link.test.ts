import { describe, expect, it } from 'vitest';
import { magicLinkCallbackURL } from './magic-link';

/**
 * What the `/auth/magic-link` landing sees as `redirectTo`, replaying better-auth
 * 1.7's magic-link plugin step by step:
 *   1. `sendMagicLink` builds the link with `url.searchParams.set('callbackURL', …)`;
 *   2. the verify request's query is parsed (one decode);
 *   3. verify does `decodeURIComponent(ctx.query.callbackURL)` (a second decode)
 *      and redirects there.
 */
function landingRedirectTo(callbackURL: string): string | null {
	const link = new URL('http://localhost/api/auth/magic-link/verify');
	link.searchParams.set('token', 't');
	link.searchParams.set('callbackURL', callbackURL);
	const parsed = new URL(link.toString()).searchParams.get('callbackURL')!;
	const target = new URL(decodeURIComponent(parsed), 'http://localhost');
	return target.searchParams.get('redirectTo');
}

describe('magicLinkCallbackURL', () => {
	it('delivers a redirectTo with its own query intact (the OAuth continuation)', () => {
		const continueTo =
			'/oauth/login?response_type=code&client_id=abc&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb' +
			'&scope=openid+read&ba_param=client_id&ba_param=scope&sig=a%2Bb%3D';

		expect(landingRedirectTo(magicLinkCallbackURL(continueTo))).toBe(continueTo);
	});

	it('delivers a plain path unchanged (the invite flow)', () => {
		expect(landingRedirectTo(magicLinkCallbackURL('/invite/tok'))).toBe('/invite/tok');
	});

	it('is the bare landing when there is nowhere to go next', () => {
		expect(magicLinkCallbackURL(null)).toBe('/auth/magic-link');
	});

	it('documents the bug it works around: single encoding truncates at the first &', () => {
		const single = '/auth/magic-link?redirectTo=' + encodeURIComponent('/oauth/login?a=1&b=2');
		expect(landingRedirectTo(single)).toBe('/oauth/login?a=1');
	});
});
