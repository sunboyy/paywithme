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

function makeLoadEvent(query = '', user: { id: string } | null = null) {
	return {
		url: new URL(`http://localhost/oauth/login${query}`),
		locals: { user }
	} as unknown as Parameters<typeof load>[0];
}

async function runLoad(query = '', user: { id: string } | null = null) {
	try {
		return { value: await load(makeLoadEvent(query, user)), redirect: null as null };
	} catch (thrown) {
		if (isRedirect(thrown)) return { value: null, redirect: thrown };
		throw thrown;
	}
}

function isRedirect(e: unknown): e is { status: number; location: string } {
	return typeof e === 'object' && e !== null && 'status' in e && 'location' in e;
}

describe('/oauth/login load', () => {
	it('exposes the authorize resume URL and the magic-link form on a genuine OAuth continuation', async () => {
		const { value } = await runLoad(OAUTH_QUERY);
		expect(value?.oauthResume?.startsWith(`${MCP_AUTHORIZE_PATH}?`)).toBe(true);
		expect(value?.form).toBeDefined();
	});

	it('sends an ALREADY-logged-in user straight to the authorize endpoint (no re-login)', async () => {
		const { redirect: r } = await runLoad(OAUTH_QUERY, { id: 'user_1' });
		expect(r?.status).toBe(303);
		expect(r?.location.startsWith(`${MCP_AUTHORIZE_PATH}?`)).toBe(true);
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

	it('threads the OAuth resume URL (the hidden redirectTo) into the magic-link callbackURL', async () => {
		const resume = `${MCP_AUTHORIZE_PATH}?response_type=code&client_id=client_abc`;
		await actions.default(makeActionEvent({ email: 'a@b.com', redirectTo: resume }));

		expect(signInMagicLink).toHaveBeenCalledTimes(1);
		expect(signInMagicLink.mock.calls[0][0].body.callbackURL).toBe(
			'/auth/magic-link?redirectTo=' + encodeURIComponent(resume)
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
