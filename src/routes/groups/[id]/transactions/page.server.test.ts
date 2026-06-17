import { describe, expect, it, vi, beforeEach } from 'vitest';

// Route test for the transaction list `load` (task 4.7): the filter state is
// parsed from `url.searchParams` and passed to `listTransactions`; the shaped
// rows + filter state come back. Services are mocked (no real DB).

const { listTransactions, requireGroupAccess } = vi.hoisted(() => ({
	listTransactions: vi.fn(),
	requireGroupAccess: vi.fn()
}));

vi.mock('$lib/server/transactions', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/transactions')>(
		'$lib/server/transactions'
	);
	return { ...actual, listTransactions };
});
vi.mock('$lib/server/access', () => ({ requireGroupAccess }));

import { load } from './+page.server';

const GROUP = { id: 'g1', name: 'Trip', settlementCurrency: 'THB' };

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
		expect(result.filters).toEqual({ type: null, category: null });
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
		expect(result.filters).toEqual({ type: 'transfer', category: 'transfer-cash' });
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
