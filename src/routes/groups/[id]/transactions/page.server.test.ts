import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { SEEDED_CURRENCY_DESCRIPTORS } from '$lib/money';

// Route test for the transaction list `load` (task 4.7): the filter state is
// parsed from `url.searchParams` and passed to `listTransactions`; the shaped
// rows + filter state come back. Services are mocked (no real DB).
//
// The GROUP-SCOPED currency set (#63; PLAN §7.5.2) is mocked here too. It is not
// optional scaffolding: `load` reads it for every row's ENTRY-currency descriptor
// (§7.6 Display), so leaving it unmocked would have the real service hit a DB that
// isn't there.

const { listTransactions, requireGroupAccess, listMembers, listCurrenciesForGroup } = vi.hoisted(
	() => ({
		listTransactions: vi.fn(),
		requireGroupAccess: vi.fn(),
		listMembers: vi.fn(),
		listCurrenciesForGroup: vi.fn()
	})
);

vi.mock('$lib/server/transactions', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/transactions')>(
		'$lib/server/transactions'
	);
	return { ...actual, listTransactions };
});
vi.mock('$lib/server/access', () => ({ requireGroupAccess }));
vi.mock('$lib/server/members', () => ({ listMembers }));
vi.mock('$lib/server/currencies', () => ({ listCurrenciesForGroup }));

import { load } from './+page.server';
import { GroupAccessError } from '$lib/server/groups';

const GROUP = { id: 'g1', name: 'Trip', settlementCurrency: 'THB' };

/** This group's own custom currency: opaque PK, member-typed display code, 0-dp. */
const BEER = {
	code: 'cur_beer',
	displayCode: 'BEER',
	name: 'Bottle of beer',
	symbol: '🍺',
	exponent: 0,
	isCustom: true
};

/** What `listCurrenciesForGroup` returns: the seeded 29 first, then the group's own. */
function groupCurrencies(custom: (typeof BEER)[] = []) {
	return [
		...SEEDED_CURRENCY_DESCRIPTORS.map((c) => ({
			...c,
			name: c.displayCode,
			isCustom: false
		})),
		...custom
	];
}

function makeLoadEvent(search: string) {
	return {
		params: { id: 'g1' },
		locals: { user: { id: 'u1', name: 'Alice' }, session: {} },
		url: new URL(`http://localhost/groups/g1/transactions${search}`)
	} as unknown as Parameters<typeof load>[0];
}

beforeEach(() => {
	listTransactions.mockReset();
	requireGroupAccess.mockReset();
	requireGroupAccess.mockResolvedValue({ user: { id: 'u1', name: 'Alice' }, group: GROUP });
	listTransactions.mockResolvedValue([]);
	listCurrenciesForGroup.mockReset();
	listCurrenciesForGroup.mockResolvedValue(groupCurrencies());
	listMembers.mockReset();
	// Two members: the viewer (linked to u1) and one other participant slot.
	listMembers.mockResolvedValue([
		{ id: 'm1', displayName: 'Alice', userId: 'u1', deactivatedAt: null, isLinked: true },
		{ id: 'm2', displayName: 'Bob', userId: null, deactivatedAt: null, isLinked: false }
	]);
});

describe('/groups/[id]/transactions load', () => {
	it('parses no filters when the query string is empty', async () => {
		const result = (await load(makeLoadEvent(''))) as {
			filters: { type: string | null; category: string | null };
			transactions: unknown[];
			currency: { code: string };
		};
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: { type: undefined, categoryId: undefined }
		});
		// Exhaustive on purpose: `filters` is the page's whole filter state, and the
		// §10 member filter added `member`/`role` to it (both null when unset).
		expect(result.filters).toEqual({ type: null, category: null, member: null, role: null });
		expect(result.currency.code).toBe('THB');
	});

	it('parses the type + category filters from the URL', async () => {
		const result = (await load(makeLoadEvent('?type=transfer&category=transfer-cash'))) as {
			filters: { type: string | null; category: string | null };
		};

		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: { type: 'transfer', categoryId: 'transfer-cash' }
		});
		expect(result.filters).toEqual({
			type: 'transfer',
			category: 'transfer-cash',
			member: null,
			role: null
		});
	});

	it('ignores an unrecognized type value (no filter)', async () => {
		await load(makeLoadEvent('?type=bogus'));
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: { type: undefined, categoryId: undefined }
		});
	});

	it('returns the shaped transactions from the service', async () => {
		listTransactions.mockResolvedValueOnce([
			{
				id: 't1',
				type: 'spending',
				title: 'Dinner',
				categoryId: 'spending-food-drink',
				categoryName: 'Food & Drink',
				categoryIcon: 'utensils',
				amountTotalSettlement: 9000,
				settlementCurrency: 'THB',
				createdAt: '2026-03-01T00:00:00.000Z'
			}
		]);
		const result = (await load(makeLoadEvent(''))) as { transactions: { id: string }[] };
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].id).toBe('t1');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The §10 MEMBER filter — "show only what relates to me (or another person)".
// ─────────────────────────────────────────────────────────────────────────────

describe('/groups/[id]/transactions load — member filter (PLAN §10)', () => {
	type MemberResult = {
		filters: { member: string | null; role: string | null };
		members: { id: string; isSelf: boolean; isInactive: boolean }[];
	};

	it('passes the member filter through and echoes it back', async () => {
		const result = (await load(makeLoadEvent('?member=m1'))) as MemberResult;
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: { type: undefined, categoryId: undefined, memberId: 'm1', memberRole: undefined }
		});
		expect(result.filters.member).toBe('m1');
		expect(result.filters.role).toBeNull();
	});

	it.each(['paid', 'owes'] as const)(
		'passes role=%s through alongside the member',
		async (role) => {
			const result = (await load(makeLoadEvent(`?member=m1&role=${role}`))) as MemberResult;
			expect(listTransactions).toHaveBeenCalledWith({
				userId: 'u1',
				groupId: 'g1',
				filters: { type: undefined, categoryId: undefined, memberId: 'm1', memberRole: role }
			});
			expect(result.filters.role).toBe(role);
		}
	);

	it('ignores an unrecognized role value (falls back to EITHER side)', async () => {
		const result = (await load(makeLoadEvent('?member=m1&role=bogus'))) as MemberResult;
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: { type: undefined, categoryId: undefined, memberId: 'm1', memberRole: undefined }
		});
		expect(result.filters.role).toBeNull();
	});

	it('DROPS a role given without a member — it never reaches the service', async () => {
		const result = (await load(makeLoadEvent('?role=paid'))) as MemberResult;
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: {
				type: undefined,
				categoryId: undefined,
				memberId: undefined,
				memberRole: undefined
			}
		});
		expect(result.filters.role).toBeNull();
	});

	it('treats an empty member param as no filter', async () => {
		const result = (await load(makeLoadEvent('?member='))) as MemberResult;
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: {
				type: undefined,
				categoryId: undefined,
				memberId: undefined,
				memberRole: undefined
			}
		});
		expect(result.filters.member).toBeNull();
	});

	it('composes with the type + category filters', async () => {
		await load(makeLoadEvent('?type=spending&category=spending-food-drink&member=m2&role=owes'));
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: {
				type: 'spending',
				categoryId: 'spending-food-drink',
				memberId: 'm2',
				memberRole: 'owes'
			}
		});
	});

	it('returns the group members, marking the viewer as self', async () => {
		const result = (await load(makeLoadEvent(''))) as MemberResult;
		expect(listMembers).toHaveBeenCalledWith({ userId: 'u1', groupId: 'g1' });
		expect(result.members).toEqual([
			{ id: 'm1', displayName: 'Alice', isSelf: true, isInactive: false },
			{ id: 'm2', displayName: 'Bob', isSelf: false, isInactive: false }
		]);
	});

	it('keeps DEACTIVATED members selectable, marked inactive (§6.3 — they keep their history)', async () => {
		listMembers.mockResolvedValueOnce([
			{
				id: 'm3',
				displayName: 'Carol',
				userId: null,
				deactivatedAt: '2026-02-01T00:00:00.000Z',
				isLinked: false
			}
		]);
		const result = (await load(makeLoadEvent(''))) as MemberResult;
		expect(result.members).toEqual([
			{ id: 'm3', displayName: 'Carol', isSelf: false, isInactive: true }
		]);
	});

	it('degrades to no member filter (rather than 500) when the member read fails', async () => {
		listMembers.mockRejectedValueOnce(new Error('db down'));
		const result = (await load(makeLoadEvent(''))) as MemberResult;
		expect(result.members).toEqual([]);
	});
});

// ── The group-scoped ENTRY-currency set reaching the page (#63; PLAN §7.5.2) ──
//
// The list renders each row's ORIGINAL amount in the currency it was RECORDED in
// (§7.6 Display). A group-defined currency exists only as a `currencies` row, so
// the page cannot format one from its code alone — the resolved descriptor has to
// travel in `data.currencies`. These assert that wiring at load level; the
// rendering itself is covered by `mount.svelte.test.ts`.
describe('/groups/[id]/transactions load — entry-currency descriptors (§7.5.2)', () => {
	it("passes the group's own custom row through to `currencies`", async () => {
		listCurrenciesForGroup.mockResolvedValue(groupCurrencies([BEER]));

		const result = (await load(makeLoadEvent(''))) as {
			currencies: { code: string; displayCode: string; symbol: string; exponent: number }[];
		};

		expect(listCurrenciesForGroup).toHaveBeenCalledWith({ userId: 'u1', groupId: 'g1' });
		expect(result.currencies).toContainEqual({
			code: 'cur_beer',
			displayCode: 'BEER',
			symbol: '🍺',
			exponent: 0
		});
	});

	it('carries every seeded currency with `displayCode === code`', async () => {
		const result = (await load(makeLoadEvent(''))) as {
			currencies: { code: string; displayCode: string }[];
		};
		// The seeded invariant (PLAN §7.5.2) — a seeded row's display code IS its code,
		// so a same-currency row keeps formatting exactly as it did before #63.
		expect(result.currencies).toHaveLength(SEEDED_CURRENCY_DESCRIPTORS.length);
		expect(result.currencies.every((c) => c.code === c.displayCode)).toBe(true);
		expect(result.currencies.find((c) => c.code === 'THB')?.displayCode).toBe('THB');
	});

	it('the settlement currency travels with a displayCode too', async () => {
		const result = (await load(makeLoadEvent(''))) as {
			currency: { code: string; displayCode: string };
		};
		expect(result.currency).toEqual(expect.objectContaining({ code: 'THB', displayCode: 'THB' }));
	});

	it('404s (never 500s) when the currency read loses the access race', async () => {
		// Access was established moments earlier, so this can only be the group
		// vanishing mid-request — the same answer the transaction read gives.
		listCurrenciesForGroup.mockRejectedValue(new GroupAccessError());
		try {
			await load(makeLoadEvent(''));
			expect.unreachable('load should have thrown');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			expect((e as { status: number }).status).toBe(404);
		}
	});

	it('PROPAGATES a real currency-read failure instead of degrading to an empty set', async () => {
		// An empty currency set is not a coherent page: a row recorded in a custom
		// currency would then have no descriptor to format with and the component would
		// throw anyway. Swallowing this is also what previously hid the fact that these
		// tests never mocked the service at all.
		listCurrenciesForGroup.mockRejectedValue(new Error('connection refused'));
		await expect(load(makeLoadEvent(''))).rejects.toThrow('connection refused');
	});
});
