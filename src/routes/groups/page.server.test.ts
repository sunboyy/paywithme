import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

// Mock the group service so the dashboard never touches a real DB. `vi.hoisted`
// makes the spy available inside the hoisted `vi.mock` factory.
const { listGroupsForUser } = vi.hoisted(() => ({ listGroupsForUser: vi.fn() }));
vi.mock('$lib/server/groups', () => ({ listGroupsForUser }));

import { load } from './+page.server';
import type { Group } from '$lib/server/groups';

type User = { id: string; name: string };

/** Minimal `load` event with `locals.user`. */
function makeLoadEvent(user: User | null) {
	return {
		locals: { user, session: user ? {} : null }
	} as unknown as Parameters<typeof load>[0];
}

/** A minimal group row as the service returns it. */
function makeGroup(overrides: Partial<Group> = {}): Group {
	return {
		id: 'g1',
		name: 'Trip',
		settlementCurrency: 'THB',
		createdBy: 'u1',
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		deletedAt: null,
		...overrides
	} as Group;
}

describe('/groups load', () => {
	beforeEach(() => {
		listGroupsForUser.mockReset();
	});

	it('redirects an anonymous user to /login and never lists groups', async () => {
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

		expect(listGroupsForUser).not.toHaveBeenCalled();
	});

	it('returns the groups from the service for an authenticated user', async () => {
		const groups = [makeGroup({ id: 'g1' }), makeGroup({ id: 'g2', settlementCurrency: 'USD' })];
		listGroupsForUser.mockResolvedValueOnce(groups);

		const result = (await load(makeLoadEvent({ id: 'u1', name: 'Alice' }))) as { groups: Group[] };

		expect(listGroupsForUser).toHaveBeenCalledTimes(1);
		expect(listGroupsForUser).toHaveBeenCalledWith('u1');
		expect(result.groups).toEqual(groups);
	});

	it('degrades to an empty list (no 500/redirect) when the service throws', async () => {
		listGroupsForUser.mockRejectedValueOnce(new Error('groups backend unavailable'));

		const result = (await load(makeLoadEvent({ id: 'u1', name: 'Alice' }))) as { groups: Group[] };

		expect(result.groups).toEqual([]);
		expect(listGroupsForUser).toHaveBeenCalledTimes(1);
	});
});
