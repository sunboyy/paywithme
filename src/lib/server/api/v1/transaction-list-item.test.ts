// Unit tests for the v1 TransactionListItem DTO mapper (PLAN §16.4, §7.6).
// Asserts the two amounts collapse into self-describing money in their correct
// (entry vs settlement) currencies, for both same-currency and foreign rows.

import { describe, it, expect } from 'vitest';
import { asEntryCurrencyCode } from '$lib/money';
import type { TransactionListItem } from '$lib/server/transactions';
import { toTransactionListItemDto } from './transaction-list-item';

function makeItem(overrides: Partial<TransactionListItem> = {}): TransactionListItem {
	return {
		id: 't1',
		type: 'spending',
		title: 'Dinner',
		createdBy: 'u1',
		categoryId: 'c1',
		categoryName: 'Food',
		categoryIcon: '🍜',
		amountTotal: 3000,
		currency: 'THB',
		amountTotalSettlement: 3000,
		settlementCurrency: 'THB',
		isForeign: false,
		createdAt: '2026-05-01T10:00:00.000Z',
		occurredAt: '2026-05-01T10:00:00.000Z',
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

	it('drops the MCP-only `createdBy` — the frozen wire contract maps a fixed subset', () => {
		// The field exists on the internal read model (the MCP list view attributes the
		// title to its author, ADR-0003) but must never reach the `/api/v1` wire.
		const dto = toTransactionListItemDto(makeItem());
		expect(dto).not.toHaveProperty('createdBy');
	});
});

// ── A group-defined entry currency (PLAN §7.5.2; ADR-0014 decision 7) ─────────
// `item.currency` holds the `currencies` PRIMARY KEY, which for a custom row is an
// opaque generated id. The route resolves the row (one query for the whole page,
// see `lib/server/entry-currency.ts`) and the mapper emits its display code.

const BEER = {
	code: 'cur_9f2e5a10-0000-4000-8000-000000000001',
	displayCode: 'BEER',
	exponent: 0,
	symbol: '🍺'
};

describe('toTransactionListItemDto — custom entry currency', () => {
	it('emits the resolved DISPLAY code, never the opaque row key', () => {
		const dto = toTransactionListItemDto(
			makeItem({
				currency: asEntryCurrencyCode(BEER.code),
				amountTotal: 3,
				amountTotalSettlement: 75000,
				isForeign: true
			}),
			BEER
		);

		expect(dto.amount).toEqual({ amount: 3, currency: 'BEER' });
		expect(JSON.stringify(dto)).not.toContain('cur_');
	});

	it('leaves the SETTLEMENT amount in the seeded settlement currency (§7.5.2)', () => {
		const dto = toTransactionListItemDto(
			makeItem({
				currency: asEntryCurrencyCode(BEER.code),
				amountTotal: 3,
				amountTotalSettlement: 75000,
				isForeign: true
			}),
			BEER
		);

		expect(dto.settlementAmount).toEqual({ amount: 75000, currency: 'THB' });
	});

	it('is unchanged for a seeded currency, resolved or not — `code == display_code`', () => {
		const item = makeItem();
		const resolved = { code: 'THB', displayCode: 'THB', exponent: 2, symbol: '฿' };
		expect(toTransactionListItemDto(item, resolved)).toEqual(toTransactionListItemDto(item));
	});
});
