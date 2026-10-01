import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the auth instance so the action never touches a real DB/network/email.
const { signInMagicLink } = vi.hoisted(() => ({ signInMagicLink: vi.fn() }));
vi.mock('$lib/server/auth', () => ({
	auth: { api: { signInMagicLink } }
}));

import { actions, load } from './+page.server';
import { MCP_AUTHORIZE_PATH } from '$lib/oauth-resume';

const OAUTH_QUERY =
	'?response_type=code&client_id=client_abc&redirect_uri=' +
	encodeURIComponent('https://claude.ai/api/mcp/auth_callback') +
	'&scope=openid%20read&code_challenge=abc&code_challenge_method=S256&state=xyz';

/** A signed-in visitor whose session was created at `createdAt`. */
interface Visitor {
	createdAt: Date;
}

function makeLoadEvent(query = '', visitor: Visitor | null = null) {
	return {
		url: new URL(`http://localhost/oauth/login${query}`),
		locals: {
			user: visitor ? { id: 'user_1' } : null,
			session: visitor ? { createdAt: visitor.createdAt } : null
		}
	} as unknown as Parameters<typeof load>[0];
}

async function runLoad(query = '', visitor: Visitor | null = null) {
	try {
		return { value: await load(makeLoadEvent(query, visitor)), redirect: null as null };
	} catch (thrown) {
		if (isRedirect(thrown)) return { value: null, redirect: thrown };
		throw thrown;
	}
}

function isRedirect(e: unknown): e is { status: number; location: string } {
	return typeof e === 'object' && e !== null && 'status' in e && 'location' in e;
}

const MINUTE = 60_000;
/** When the provider sent the user here (the signed `ba_iat`). */
const ISSUED_AT = Date.now() - 2 * MINUTE;
/** A session from before this request. */
const OLD_SESSION = { createdAt: new Date(ISSUED_AT - 30 * MINUTE) };
/** A session made by signing in on this page. */
const FRESH_SESSION = { createdAt: new Date(ISSUED_AT + MINUTE) };
const SIGNED = `&ba_iat=${ISSUED_AT}&exp=1&sig=abc`;

describe('/oauth/login load', () => {
	it('shows the sign-in form to an anonymous visitor, continuing back to this page', async () => {
		const { value } = await runLoad(OAUTH_QUERY + SIGNED);
		expect(value?.form).toBeDefined();
		// Both sign-in paths come back HERE, with the request intact; `load` then resumes.
		expect(value?.continueTo).toBe(`/oauth/login${OAUTH_QUERY}${SIGNED}`);
	});

	it('sends an already-signed-in user straight to the authorize endpoint (no re-login)', async () => {
		const { redirect: r } = await runLoad(OAUTH_QUERY + SIGNED, OLD_SESSION);
		expect(r?.status).toBe(303);
		expect(r?.location.startsWith(`${MCP_AUTHORIZE_PATH}?`)).toBe(true);
	});

	it('prompt=login: an older session gets the form, not a resume (e.g. after a cancelled passkey)', async () => {
		const { value, redirect: r } = await runLoad(
			OAUTH_QUERY + '&prompt=login' + SIGNED,
			OLD_SESSION
		);
		expect(r).toBeNull();
		expect(value?.form).toBeDefined();
	});

	it('prompt=login: a session created for this request resumes, without prompt=login', async () => {
		const { redirect: r } = await runLoad(OAUTH_QUERY + '&prompt=login' + SIGNED, FRESH_SESSION);
		expect(r?.status).toBe(303);
		expect(r?.location.startsWith(`${MCP_AUTHORIZE_PATH}?`)).toBe(true);
		expect(r?.location).not.toContain('prompt');
	});

	it('max_age: a session within the allowed age resumes without signing in again', async () => {
		const { redirect: r } = await runLoad(OAUTH_QUERY + '&max_age=3600' + SIGNED, OLD_SESSION);
		expect(r?.status).toBe(303);
		// Kept: the authorize endpoint checks it again.
		expect(r?.location).toContain('max_age=3600');
	});

	it('max_age: a session older than allowed gets the form', async () => {
		const { redirect: r } = await runLoad(OAUTH_QUERY + '&max_age=60' + SIGNED, OLD_SESSION);
		expect(r).toBeNull();
	});

	it('max_age=0: only a fresh sign-in passes, and the param is then dropped', async () => {
		expect((await runLoad(OAUTH_QUERY + '&max_age=0' + SIGNED, OLD_SESSION)).redirect).toBeNull();
		const { redirect: r } = await runLoad(OAUTH_QUERY + '&max_age=0' + SIGNED, FRESH_SESSION);
		expect(r?.status).toBe(303);
		expect(r?.location).not.toContain('max_age');
	});

	it('redirects to the normal /login when reached WITHOUT an OAuth request (not a general login)', async () => {
		const { redirect: r } = await runLoad('');
		expect(r?.status).toBe(303);
		expect(r?.location).toBe('/login');
	});

	it('also redirects to /login for a partial/invalid OAuth request (missing client_id)', async () => {
		const { redirect: r } = await runLoad('?response_type=code&redirect_uri=https%3A%2F%2Fx');
		expect(r?.location).toBe('/login');
	});
});

/** Build a SvelteKit-action-style `RequestEvent` with a form-encoded POST body. */
function makeActionEvent(fields: Record<string, string>) {
	const body = new URLSearchParams(fields);
	const request = new Request('http://localhost/oauth/login', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: body.toString()
	});
	return { request } as unknown as Parameters<(typeof actions)['default']>[0];
}

describe('/oauth/login default action (mirrors /login privacy contract)', () => {
	beforeEach(() => {
		signInMagicLink.mockReset();
		signInMagicLink.mockResolvedValue({ status: true });
	});

	it('threads this page (the hidden redirectTo) into the magic-link callbackURL', async () => {
		const resume = `/oauth/login${OAUTH_QUERY}`;
		await actions.default(makeActionEvent({ email: 'a@b.com', redirectTo: resume }));

		expect(signInMagicLink).toHaveBeenCalledTimes(1);
		expect(signInMagicLink.mock.calls[0][0].body.callbackURL).toBe(
			'/auth/magic-link?redirectTo=' + encodeURIComponent(encodeURIComponent(resume))
		);
		// Email-only (login collects no name), same as /login.
		expect(signInMagicLink.mock.calls[0][0].body).not.toHaveProperty('name');
	});

	it('drops an UNSAFE redirectTo (open redirect) and keeps the bare callbackURL', async () => {
		await actions.default(makeActionEvent({ email: 'a@b.com', redirectTo: '//evil.com' }));
		expect(signInMagicLink.mock.calls[0][0].body.callbackURL).toBe('/auth/magic-link');
	});

	it('returns a generic error (no leak) when the magic-link send fails', async () => {
		signInMagicLink.mockRejectedValueOnce(new Error('SMTP exploded: user did not exist'));
		const result = (await actions.default(makeActionEvent({ email: 'a@b.com' }))) as {
			status: number;
			data: { form: { message?: { type: string; text: string } } };
		};
		expect(result.status).toBe(500);
		expect(result.data.form.message?.type).toBe('error');
		expect(result.data.form.message?.text).not.toContain('SMTP');
	});

	it('returns a 400 fail and does NOT call the auth API on invalid input', async () => {
		const result = (await actions.default(makeActionEvent({ email: 'nope' }))) as {
			status: number;
			data: { form: { valid: boolean } };
		};
		expect(signInMagicLink).not.toHaveBeenCalled();
		expect(result.status).toBe(400);
		expect(result.data.form.valid).toBe(false);
	});
});
