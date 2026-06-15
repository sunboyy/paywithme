import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

// Mock the auth instance so nothing touches a real DB/network. `listPasskeys` is
// a spy we drive per-test. `vi.hoisted` makes it available inside the hoisted
// `vi.mock` factory.
const { listPasskeys } = vi.hoisted(() => ({ listPasskeys: vi.fn() }));
vi.mock('$lib/server/auth', () => ({
	auth: { api: { listPasskeys } }
}));

import { load } from './+page.server';

type User = { name: string };

/** Minimal `load` event with `locals.user` + a real `request` (headers used). */
function makeLoadEvent(user: User | null) {
	return {
		request: new Request('http://localhost/onboarding/passkey'),
		locals: { user, session: user ? {} : null }
	} as unknown as Parameters<typeof load>[0];
}

describe('/onboarding/passkey load', () => {
	beforeEach(() => {
		listPasskeys.mockReset();
	});

	it('redirects an anonymous user to /login and never lists passkeys', async () => {
		try {
			await load(makeLoadEvent(null));
			expect.unreachable('expected a redirect to be thrown');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/login');
			}
		}

		expect(listPasskeys).not.toHaveBeenCalled();
	});

	it('redirects to / when the user already has a passkey (self-gate)', async () => {
		listPasskeys.mockResolvedValueOnce([{ id: 'pk_1', name: 'iPhone' }]);

		try {
			await load(makeLoadEvent({ name: 'Alice' }));
			expect.unreachable('expected a redirect to be thrown');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/');
			}
		}

		expect(listPasskeys).toHaveBeenCalledTimes(1);
	});

	it('renders the nudge (returns {}) when the user has no passkey', async () => {
		listPasskeys.mockResolvedValueOnce([]);

		const result = await load(makeLoadEvent({ name: 'Alice' }));

		expect(result).toEqual({});
		expect(listPasskeys).toHaveBeenCalledTimes(1);
	});

	it('degrades gracefully (returns {}, no 500/redirect) when listPasskeys throws', async () => {
		listPasskeys.mockRejectedValueOnce(new Error('passkey list backend unavailable'));

		const result = await load(makeLoadEvent({ name: 'Alice' }));

		expect(result).toEqual({});
		expect(listPasskeys).toHaveBeenCalledTimes(1);
	});
});
