import { describe, expect, it } from 'vitest';
import { isOAuthContinuation, oauthResumeUrl, MCP_AUTHORIZE_PATH } from './oauth-resume';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const MINUTE = 60_000;
/** When the provider sent the user to the login page (the signed `ba_iat`). */
const ISSUED_AT = NOW.getTime() - 2 * MINUTE;
/** A session from before the request (e.g. signed in yesterday). */
const OLD = new Date(ISSUED_AT - 24 * 60 * MINUTE);
/** A session created by signing in for this request. */
const FRESH = new Date(ISSUED_AT + MINUTE);

/**
 * Resume for a session created at `createdAt` (default: an old one), for a
 * request whose VERIFIED issue time is `issuedAt` (`null`: signature unverified).
 */
function resume(
	search: URLSearchParams,
	createdAt: Date = OLD,
	issuedAt: Date | null = new Date(ISSUED_AT)
): string | null {
	return oauthResumeUrl(search, createdAt, issuedAt, NOW);
}

/** The params the OAuth authorize endpoint appends when it bounces to /oauth/login. */
function authorizeParams(overrides: Record<string, string> = {}): URLSearchParams {
	return new URLSearchParams({
		response_type: 'code',
		client_id: 'client_abc',
		redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
		scope: 'openid read',
		code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
		code_challenge_method: 'S256',
		state: 'xyz',
		...overrides
	});
}

describe('oauthResumeUrl — the forwarded request', () => {
	it('rebuilds the authorization endpoint URL for a genuine OAuth continuation', () => {
		const url = resume(authorizeParams());
		expect(url).not.toBeNull();
		expect(url!.startsWith(`${MCP_AUTHORIZE_PATH}?`)).toBe(true);

		// Every OAuth request param is forwarded verbatim so the resumed authorize
		// issues a code for the SAME client + PKCE challenge Claude.ai started with.
		const forwarded = new URLSearchParams(url!.slice(url!.indexOf('?') + 1));
		expect(forwarded.get('response_type')).toBe('code');
		expect(forwarded.get('client_id')).toBe('client_abc');
		expect(forwarded.get('redirect_uri')).toBe('https://claude.ai/api/mcp/auth_callback');
		expect(forwarded.get('code_challenge')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
		expect(forwarded.get('code_challenge_method')).toBe('S256');
		expect(forwarded.get('state')).toBe('xyz');
		expect(forwarded.get('scope')).toBe('openid read');
	});

	it('is a same-origin path (never an open redirect, despite the off-origin redirect_uri param)', () => {
		const url = resume(authorizeParams());
		expect(url!.startsWith('/')).toBe(true);
		expect(url!.startsWith('//')).toBe(false);
		// The claude.ai URL is only a query param, not the navigation target.
		expect(url!.startsWith(MCP_AUTHORIZE_PATH)).toBe(true);
	});

	it('targets the oauth-provider authorize endpoint', () => {
		expect(MCP_AUTHORIZE_PATH).toBe('/api/auth/oauth2/authorize');
	});

	it('drops the provider signing params (sig, exp, ba_*), which are not part of the request', () => {
		const signed = authorizeParams({ exp: '1790784420', ba_iat: '1790783820375', sig: 'abc=' });
		signed.append('ba_param', 'client_id');
		signed.append('ba_param', 'scope');
		signed.set('ba_pl', 'session_1');

		const forwarded = new URLSearchParams(resume(signed)!.split('?')[1]);

		for (const param of ['sig', 'exp', 'ba_iat', 'ba_param', 'ba_pl']) {
			expect(forwarded.has(param)).toBe(false);
		}
		expect(forwarded.get('client_id')).toBe('client_abc');
	});

	it('drops our own redirectTo param (it is not part of the OAuth request)', () => {
		const url = resume(authorizeParams({ redirectTo: '/invite/tok' }));
		const forwarded = new URLSearchParams(url!.slice(url!.indexOf('?') + 1));
		expect(forwarded.has('redirectTo')).toBe(false);
	});

	it('returns null for a plain login visit (no OAuth params)', () => {
		expect(resume(new URLSearchParams())).toBeNull();
	});

	it('returns null for the invite flow (redirectTo only, no OAuth request)', () => {
		expect(resume(new URLSearchParams({ redirectTo: '/invite/tok' }))).toBeNull();
	});

	it('returns null when any required OAuth param is missing', () => {
		// response_type not "code"
		expect(resume(authorizeParams({ response_type: 'token' }))).toBeNull();
		// missing client_id
		const noClient = authorizeParams();
		noClient.delete('client_id');
		expect(resume(noClient)).toBeNull();
		// missing redirect_uri
		const noRedirect = authorizeParams();
		noRedirect.delete('redirect_uri');
		expect(resume(noRedirect)).toBeNull();
	});
});

describe('oauthResumeUrl — prompt=login', () => {
	const params = (prompt: string) => authorizeParams({ prompt });

	it('refuses an older session, so the user signs in again first', () => {
		expect(resume(params('login'), OLD)).toBeNull();
		expect(resume(params('consent login'), OLD)).toBeNull();
	});

	it('resumes for a session created after the request, dropping only `login`', () => {
		const forwarded = new URLSearchParams(resume(params('login consent'), FRESH)!.split('?')[1]);
		expect(forwarded.get('prompt')).toBe('consent');
		expect(new URLSearchParams(resume(params('login'), FRESH)!.split('?')[1]).has('prompt')).toBe(
			false
		);
	});

	it('cannot be satisfied when the request signature did not verify', () => {
		// Even a session created "after" a typed-in `ba_iat`: unverified means no
		// session counts as fresh.
		expect(
			resume(authorizeParams({ prompt: 'login', ba_iat: String(ISSUED_AT) }), FRESH, null)
		).toBeNull();
	});
});

describe('oauthResumeUrl — max_age', () => {
	const params = (maxAge: string) => authorizeParams({ max_age: maxAge });

	it('lets an older session through when it is within max_age, keeping the param for authorize', () => {
		// The reviewed bug: max_age=3600 must not force a re-login for a 10-minute-old session.
		const tenMinutesOld = new Date(NOW.getTime() - 10 * MINUTE - 3 * MINUTE);
		const url = resume(authorizeParams({ max_age: '3600' }), tenMinutesOld, NOW);
		expect(url).not.toBeNull();
		expect(new URLSearchParams(url!.split('?')[1]).get('max_age')).toBe('3600');
	});

	it('refuses a session older than max_age', () => {
		expect(resume(params('3600'), OLD)).toBeNull();
	});

	it('max_age=0 refuses any older session, and a fresh one passes with the param dropped', () => {
		expect(resume(params('0'), OLD)).toBeNull();
		const url = resume(params('0'), FRESH);
		expect(new URLSearchParams(url!.split('?')[1]).has('max_age')).toBe(false);
	});

	it('an unverified request never drops max_age=0 (the reviewed bypass)', () => {
		expect(resume(params('0'), FRESH, null)).toBeNull();
	});

	it('refuses a malformed max_age unless the session is fresh', () => {
		expect(resume(params('soon'), OLD)).toBeNull();
		expect(resume(params('soon'), FRESH)).not.toBeNull();
	});
});

describe('isOAuthContinuation', () => {
	it('needs response_type=code, client_id and redirect_uri', () => {
		expect(isOAuthContinuation(authorizeParams())).toBe(true);
		expect(isOAuthContinuation(new URLSearchParams({ redirectTo: '/invite/tok' }))).toBe(false);
	});
});
