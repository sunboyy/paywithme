import { describe, expect, it } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

import { load } from './+page.server';

/** Minimal root `load` event carrying the given `locals`. */
function makeEvent(user: { id: string } | null) {
	return {
		locals: { user, session: user ? {} : null }
	} as unknown as Parameters<typeof load>[0];
}

describe('root +page.server load', () => {
	it('redirects a logged-in user to /groups', () => {
		try {
			load(makeEvent({ id: 'u1' }));
			expect.unreachable('expected a redirect to be thrown');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/groups');
			}
		}
	});

	it('does not redirect an anonymous visitor', () => {
		expect(load(makeEvent(null))).toEqual({});
	});
});
