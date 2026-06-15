import { describe, expect, it } from 'vitest';

import { load } from './+layout.server';

/** Build a minimal layout-load event carrying the given `locals`. */
function makeEvent(locals: App.Locals) {
	return { locals } as unknown as Parameters<typeof load>[0];
}

describe('root +layout.server load', () => {
	it('projects only name + email for an authenticated user', () => {
		const user = {
			id: 'u1',
			name: 'Alice Example',
			email: 'alice@example.com',
			// Extra fields that must NOT be forwarded to the client chrome.
			createdAt: new Date(),
			emailVerified: true
		} as unknown as App.Locals['user'];

		const result = load(makeEvent({ user, session: null })) as {
			user: { name: string; email: string } | null;
		};

		expect(result).toEqual({ user: { name: 'Alice Example', email: 'alice@example.com' } });
		// Guard against over-exposing the rest of the user record.
		expect(Object.keys(result.user ?? {})).toEqual(['name', 'email']);
	});

	it('returns null user for an anonymous request', () => {
		const result = load(makeEvent({ user: null, session: null }));
		expect(result).toEqual({ user: null });
	});
});
