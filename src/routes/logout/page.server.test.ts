import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

// Mock the auth instance so the action never touches a real DB/network. The
// `sveltekitCookies` plugin handles clearing the cookie at request time; here we
// only assert that `signOut` is invoked with the forwarded headers and that the
// action redirects regardless of outcome. `vi.hoisted` makes the spy available
// inside the hoisted `vi.mock` factory.
const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock('$lib/server/auth', () => ({
	auth: { api: { signOut } }
}));

import { actions, load } from './+page.server';

/** Build a SvelteKit-action-style `RequestEvent` with a POST body + headers. */
function makeEvent() {
	const request = new Request('http://localhost/logout', {
		method: 'POST',
		headers: { cookie: 'better-auth.session_token=abc123' }
	});
	return { request } as unknown as Parameters<(typeof actions)['default']>[0];
}

describe('/logout default action', () => {
	beforeEach(() => {
		signOut.mockReset();
		signOut.mockResolvedValue({ success: true });
	});

	it('invalidates the session then redirects to /login', async () => {
		// The action redirects by THROWING; capture the thrown redirect.
		let thrown: unknown;
		try {
			await actions.default(makeEvent());
		} catch (e) {
			thrown = e;
		}

		// signOut was called once, with the request headers forwarded so
		// better-auth can identify the session to clear.
		expect(signOut).toHaveBeenCalledTimes(1);
		expect(signOut.mock.calls[0][0].headers).toBeInstanceOf(Headers);

		expect(isRedirect(thrown)).toBe(true);
		const redirect = thrown as { status: number; location: string };
		expect(redirect.status).toBe(303);
		expect(redirect.location).toBe('/login');
	});

	it('still redirects to /login (and leaks nothing) when signOut rejects', async () => {
		signOut.mockRejectedValueOnce(new Error('session store exploded: token xyz'));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		let thrown: unknown;
		try {
			await actions.default(makeEvent());
		} catch (e) {
			thrown = e;
		}

		// A failed sign-out must NOT swallow the redirect — the user intent is
		// "get me out". The thrown value is the redirect, never the raw error.
		expect(isRedirect(thrown)).toBe(true);
		const redirect = thrown as { status: number; location: string };
		expect(redirect.status).toBe(303);
		expect(redirect.location).toBe('/login');

		// The cause is logged server-side but never re-thrown to the user.
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});
});

describe('/logout load (bare GET)', () => {
	it('redirects to / instead of erroring (logout is POST-only)', () => {
		let thrown: unknown;
		try {
			load({} as unknown as Parameters<typeof load>[0]);
		} catch (e) {
			thrown = e;
		}

		expect(isRedirect(thrown)).toBe(true);
		const redirect = thrown as { status: number; location: string };
		expect(redirect.status).toBe(303);
		expect(redirect.location).toBe('/');
	});
});
