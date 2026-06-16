import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

// Mock the auth instance so nothing touches a real DB/network. `updateUser` is
// a spy we assert against. `vi.hoisted` makes it available inside the hoisted
// `vi.mock` factory.
const { updateUser } = vi.hoisted(() => ({ updateUser: vi.fn() }));
vi.mock('$lib/server/auth', () => ({
	auth: { api: { updateUser } }
}));

import { actions, load } from './+page.server';

type User = { name: string };

/** Minimal `load` event with a URL and `locals.user`. */
function makeLoadEvent(search: string, user: User | null) {
	return {
		url: new URL(`http://localhost/auth/magic-link${search}`),
		locals: { user, session: user ? {} : null }
	} as unknown as Parameters<typeof load>[0];
}

/** Action-style event with a form-encoded POST body + `locals.user`. */
function makeActionEvent(fields: Record<string, string>, user: User | null) {
	const request = new Request('http://localhost/auth/magic-link', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(fields).toString()
	});
	return { request, locals: { user, session: user ? {} : null } } as unknown as Parameters<
		(typeof actions)['default']
	>[0];
}

describe('/auth/magic-link load', () => {
	it('maps ?error=INVALID_TOKEN to friendly copy and does not redirect or leak the code', async () => {
		const result = (await load(makeLoadEvent('?error=INVALID_TOKEN', null))) as { error: string };

		expect(result.error).toBeTruthy();
		expect(result.error).not.toContain('INVALID_TOKEN');
		expect(result.error.toLowerCase()).toContain('invalid');
	});

	it('returns the invalid-link error state when there is no user and no error param', async () => {
		const result = (await load(makeLoadEvent('', null))) as { error: string };

		expect(result.error).toBeTruthy();
		// Same non-leaky retry-state copy as a bad token.
		expect(result.error).not.toContain('INVALID_TOKEN');
		expect(result.error.toLowerCase()).toContain('invalid');
	});

	it('redirects an authenticated, already-named user to /onboarding/passkey (303)', async () => {
		try {
			await load(makeLoadEvent('', { name: 'Alice' }));
			expect.unreachable('expected a redirect to be thrown');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/onboarding/passkey');
			}
		}
	});

	it('redirects an already-named user to a sanitized redirectTo (overrides onboarding)', async () => {
		try {
			await load(makeLoadEvent('?redirectTo=%2Finvite%2Ftok-abc', { name: 'Alice' }));
			expect.unreachable('expected a redirect to be thrown');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/invite/tok-abc');
			}
		}
	});

	it('ignores an UNSAFE redirectTo and still routes to /onboarding/passkey', async () => {
		try {
			await load(makeLoadEvent('?redirectTo=https%3A%2F%2Fevil.com', { name: 'Alice' }));
			expect.unreachable('expected a redirect to be thrown');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.location).toBe('/onboarding/passkey');
			}
		}
	});

	it('passes a sanitized redirectTo to the capture form data', async () => {
		const result = (await load(makeLoadEvent('?redirectTo=%2Finvite%2Ftok-abc', { name: '' }))) as {
			form: unknown;
			redirectTo: string | null;
		};
		expect(result.redirectTo).toBe('/invite/tok-abc');
	});

	it('renders the capture form for an authenticated user with an empty name', async () => {
		const result = (await load(makeLoadEvent('', { name: '' }))) as {
			form: { valid: boolean; data: { name: string } };
		};

		expect(result.form).toBeDefined();
		expect(result.form.valid).toBe(false);
		expect(result.form.data.name).toBe('');
	});

	it('treats a whitespace-only name as "no name" and renders the capture form', async () => {
		const result = (await load(makeLoadEvent('', { name: '   ' }))) as {
			form: { valid: boolean };
		};
		expect(result.form).toBeDefined();
	});
});

describe('/auth/magic-link default action', () => {
	beforeEach(() => {
		updateUser.mockReset();
		updateUser.mockResolvedValue({ status: true });
	});

	it('saves the normalized name then redirects to /onboarding/passkey (303)', async () => {
		try {
			await actions.default(makeActionEvent({ name: '  Alice  ' }, { name: '' }));
			expect.unreachable('expected a redirect to be thrown');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/onboarding/passkey');
			}
		}

		expect(updateUser).toHaveBeenCalledTimes(1);
		const arg = updateUser.mock.calls[0][0];
		expect(arg.body).toEqual({ name: 'Alice' });
		expect(arg.headers).toBeInstanceOf(Headers);
	});

	it('redirects to a sanitized redirectTo after saving the name (overrides onboarding)', async () => {
		try {
			await actions.default(
				makeActionEvent({ name: 'Alice', redirectTo: '/invite/tok-abc' }, { name: '' })
			);
			expect.unreachable('expected a redirect to be thrown');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/invite/tok-abc');
			}
		}
		expect(updateUser).toHaveBeenCalledTimes(1);
	});

	it('falls back to /onboarding/passkey when redirectTo is unsafe (unchanged behavior)', async () => {
		try {
			await actions.default(
				makeActionEvent({ name: 'Alice', redirectTo: '//evil.com' }, { name: '' })
			);
			expect.unreachable('expected a redirect to be thrown');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.location).toBe('/onboarding/passkey');
			}
		}
	});

	it('returns a 400 fail and does NOT call updateUser on an invalid (empty) name', async () => {
		const result = (await actions.default(makeActionEvent({ name: '' }, { name: '' }))) as {
			status: number;
			data: { form: { valid: boolean } };
		};

		expect(updateUser).not.toHaveBeenCalled();
		expect(result.status).toBe(400);
		expect(result.data.form.valid).toBe(false);
	});

	it('returns a 401 fail and does NOT call updateUser when there is no session', async () => {
		const result = (await actions.default(makeActionEvent({ name: 'Alice' }, null))) as {
			status: number;
		};

		expect(updateUser).not.toHaveBeenCalled();
		expect(result.status).toBe(401);
	});

	it('returns a generic 500 error (no leak) when updateUser rejects', async () => {
		updateUser.mockRejectedValueOnce(new Error('DB exploded: user 42 constraint violation'));

		const result = (await actions.default(makeActionEvent({ name: 'Alice' }, { name: '' }))) as {
			status: number;
			data: { form: { message?: { type: string; text: string } } };
		};

		expect(result.status).toBe(500);
		const message = result.data.form.message;
		expect(message?.type).toBe('error');
		// The raw cause must never reach the user (PLAN §12).
		expect(message?.text).not.toContain('DB exploded');
		expect(message?.text).not.toContain('constraint');
	});
});
