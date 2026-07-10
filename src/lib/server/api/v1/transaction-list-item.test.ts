// Unit tests for the v1 TransactionListItem DTO mapper (PLAN §16.4, §7.6).
// Asserts the two amounts collapse into self-describing money in their correct
// (entry vs settlement) currencies, for both same-currency and foreign rows.

import { describe, it, expect } from 'vitest';
import type { TransactionListItem } from '$lib/server/transactions';
import { toTransactionListItemDto } from './transaction-list-item';

function makeItem(overrides: Partial<TransactionListItem> = {}): TransactionListItem {
	return {
		id: 't1',
		type: 'spending',
		title: 'Dinner',
		categoryId: 'c1',
		categoryName: 'Food',
		categoryIcon: '🍜',
		amountTotal: 3000,
		currency: 'THB',
		amountTotalSettlement: 3000,
		settlementCurrency: 'THB',
		isForeign: false,
		createdAt: '2026-05-01T10:00:00.000Z',
		...overrides
	};
}

describe('toTransactionListItemDto', () => {
	it('maps a same-currency row with both amounts as money', () => {
		const dto = toTransactionListItemDto(makeItem());
		expect(dto).toEqual({
			id: 't1',
			type: 'spending',
			title: 'Dinner',
			categoryId: 'c1',
			categoryName: 'Food',
			categoryIcon: '🍜',
			amount: { amount: 3000, currency: 'THB' },
			settlementAmount: { amount: 3000, currency: 'THB' },
			isForeign: false,
			createdAt: '2026-05-01T10:00:00.000Z'
		});
	});

	it('keeps entry and settlement amounts in their own currencies for a foreign row', () => {
		const dto = toTransactionListItemDto(
			makeItem({
				amountTotal: 1000,
				currency: 'USD',
				amountTotalSettlement: 35000,
				settlementCurrency: 'THB',
				isForeign: true
			})
		);
		expect(dto.amount).toEqual({ amount: 1000, currency: 'USD' });
		expect(dto.settlementAmount).toEqual({ amount: 35000, currency: 'THB' });
		expect(dto.isForeign).toBe(true);
	});

	it('does not leak the flat amountTotal / settlementCurrency scalars', () => {
		const dto = toTransactionListItemDto(makeItem());
		expect(dto).not.toHaveProperty('amountTotal');
		expect(dto).not.toHaveProperty('amountTotalSettlement');
		expect(dto).not.toHaveProperty('settlementCurrency');
	});
});
