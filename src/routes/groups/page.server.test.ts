import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

// Mock the group service so the dashboard never touches a real DB. `vi.hoisted`
// makes the spy available inside the hoisted `vi.mock` factory.
const { listGroupsForUser } = vi.hoisted(() => ({ listGroupsForUser: vi.fn() }));
vi.mock('$lib/server/groups', () => ({ listGroupsForUser }));

// Same for the batched per-group net-balance lookup that feeds each card's
// "you are owed / you owe" figure.
const { getUserNetBalanceByGroup } = vi.hoisted(() => ({ getUserNetBalanceByGroup: vi.fn() }));
vi.mock('$lib/server/balances', () => ({ getUserNetBalanceByGroup }));

import { load } from './+page.server';
import type { Group } from '$lib/server/groups';

type User = { id: string; name: string };

/** A group as the dashboard projects it: the service row plus the net-balance fields. */
type GroupCard = Group & { net: number | null; netFormatted: string | null };

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
		getUserNetBalanceByGroup.mockReset();
		getUserNetBalanceByGroup.mockResolvedValue(new Map());
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
		expect(getUserNetBalanceByGroup).not.toHaveBeenCalled();
	});

	it('returns the groups from the service for an authenticated user', async () => {
		const groups = [makeGroup({ id: 'g1' }), makeGroup({ id: 'g2', settlementCurrency: 'USD' })];
		listGroupsForUser.mockResolvedValueOnce(groups);

		const result = (await load(makeLoadEvent({ id: 'u1', name: 'Alice' }))) as {
			groups: GroupCard[];
		};

		expect(listGroupsForUser).toHaveBeenCalledTimes(1);
		expect(listGroupsForUser).toHaveBeenCalledWith('u1');
		// Every service field is passed through untouched; the balance projection is
		// additive.
		expect(result.groups.map((g) => g.id)).toEqual(['g1', 'g2']);
		for (const [i, card] of result.groups.entries()) {
			expect(card).toMatchObject(groups[i]);
		}
	});

	// ── The per-card "you are owed / you owe" projection ────────────────────────
	describe('net balance per card', () => {
		it('asks for every listed group in ONE batched call, not one per group', async () => {
			listGroupsForUser.mockResolvedValueOnce([
				makeGroup({ id: 'g1' }),
				makeGroup({ id: 'g2' }),
				makeGroup({ id: 'g3' })
			]);

			await load(makeLoadEvent({ id: 'u1', name: 'Alice' }));

			expect(getUserNetBalanceByGroup).toHaveBeenCalledTimes(1);
			expect(getUserNetBalanceByGroup).toHaveBeenCalledWith({
				userId: 'u1',
				groupIds: ['g1', 'g2', 'g3']
			});
		});

		it('formats the ABSOLUTE amount — the card supplies the direction wording', async () => {
			listGroupsForUser.mockResolvedValueOnce([makeGroup({ id: 'g1', settlementCurrency: 'USD' })]);
			getUserNetBalanceByGroup.mockResolvedValueOnce(new Map([['g1', -2500]]));

			const result = (await load(makeLoadEvent({ id: 'u1', name: 'Alice' }))) as {
				groups: GroupCard[];
			};

			// Sign is preserved on `net` (the card branches on it) but stripped from
			// the display string, so "you owe -$25.00" can never render.
			expect(result.groups[0].net).toBe(-2500);
			expect(result.groups[0].netFormatted).toBe('USD $25.00');
		});

		it('keeps a zero balance as 0 (settled up), NOT as unknown', async () => {
			listGroupsForUser.mockResolvedValueOnce([makeGroup({ id: 'g1' })]);
			getUserNetBalanceByGroup.mockResolvedValueOnce(new Map([['g1', 0]]));

			const result = (await load(makeLoadEvent({ id: 'u1', name: 'Alice' }))) as {
				groups: GroupCard[];
			};

			expect(result.groups[0].net).toBe(0);
		});

		it('reports an ABSENT group as unknown (null), so the card stays silent', async () => {
			listGroupsForUser.mockResolvedValueOnce([makeGroup({ id: 'g1' })]);
			getUserNetBalanceByGroup.mockResolvedValueOnce(new Map());

			const result = (await load(makeLoadEvent({ id: 'u1', name: 'Alice' }))) as {
				groups: GroupCard[];
			};

			// null is distinct from 0: "we don't know" must not claim you're square.
			expect(result.groups[0].net).toBeNull();
			expect(result.groups[0].netFormatted).toBeNull();
		});

		it('still renders the cards when the balance lookup throws', async () => {
			listGroupsForUser.mockResolvedValueOnce([makeGroup({ id: 'g1' })]);
			getUserNetBalanceByGroup.mockRejectedValueOnce(new Error('balances unavailable'));

			const result = (await load(makeLoadEvent({ id: 'u1', name: 'Alice' }))) as {
				groups: GroupCard[];
			};

			expect(result.groups).toHaveLength(1);
			expect(result.groups[0].net).toBeNull();
		});

		it('skips the balance query entirely when there are no groups', async () => {
			listGroupsForUser.mockResolvedValueOnce([]);

			const result = (await load(makeLoadEvent({ id: 'u1', name: 'Alice' }))) as {
				groups: GroupCard[];
			};

			expect(result.groups).toEqual([]);
			expect(getUserNetBalanceByGroup).toHaveBeenCalledWith({ userId: 'u1', groupIds: [] });
		});
	});

	it('degrades to an empty list (no 500/redirect) when the service throws', async () => {
		listGroupsForUser.mockRejectedValueOnce(new Error('groups backend unavailable'));

		const result = (await load(makeLoadEvent({ id: 'u1', name: 'Alice' }))) as {
			groups: GroupCard[];
		};

		expect(result.groups).toEqual([]);
		expect(listGroupsForUser).toHaveBeenCalledTimes(1);
	});
});
