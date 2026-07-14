// Unit tests for the v1 TransactionDetail DTO mapper (PLAN §16.4).
// Asserts `input` is dropped, every monetary value nests as money in its correct
// currency (payers/items = entry, shares = settlement), a charge `value` stays a
// bare scalar, and `deletedAt` survives for a soft-deleted txn.

import { describe, it, expect } from 'vitest';
import type { TransactionDetail } from '$lib/server/transactions';
import { toTransactionDetailDto } from './transaction-detail';

function makeDetail(overrides: Partial<TransactionDetail> = {}): TransactionDetail {
	return {
		id: 't1',
		groupId: 'g1',
		type: 'spending',
		title: 'Dinner',
		categoryId: 'c1',
		categoryName: 'Food',
		categoryIcon: '🍜',
		// Who authored the title (§7.1 `created_by`). Internal: the MCP view needs it for
		// the untrusted envelope's author (ADR-0003); the v1 DTO must NOT carry it.
		createdBy: 'u_author',
		amountTotal: 1000,
		currency: 'USD',
		amountTotalSettlement: 35000,
		settlementCurrency: 'THB',
		isForeign: true,
		splitMode: 'itemized',
		createdAt: '2026-05-01T10:00:00.000Z',
		deletedAt: null,
		payers: [{ memberId: 'm1', amountPaid: 1000 }],
		shares: [
			{ memberId: 'm1', amountOwed: 20000 },
			{ memberId: 'm2', amountOwed: 15000 }
		],
		items: [
			{
				label: 'Ramen',
				amount: 600,
				splitMode: 'equal',
				shares: [{ memberId: 'm1', amountOwed: 10500 }]
			}
		],
		charges: [
			{ kind: 'vat', mode: 'percent', value: 7, base: 'items_subtotal', sortOrder: 0 },
			{ kind: 'tip', mode: 'absolute', value: 200, base: 'running_total', sortOrder: 1 }
		],
		// The internal edit-form seed that MUST be dropped on the wire.
		input: { sentinel: 'must-not-leak' } as unknown as TransactionDetail['input'],
		...overrides
	};
}

describe('toTransactionDetailDto', () => {
	it('drops the internal `input` edit-form seed', () => {
		const dto = toTransactionDetailDto(makeDetail());
		expect(dto).not.toHaveProperty('input');
	});

	it('drops the internal `createdBy` — the v1 contract is FROZEN (ADR-0006)', () => {
		// The MCP view layer needs the author (to attribute untrusted text); `/api/v1`
		// does not serve it, and adding it would change a published, spec-backed DTO.
		const dto = toTransactionDetailDto(makeDetail());
		expect(dto).not.toHaveProperty('createdBy');
	});

	it('nests entry-currency amounts (total, payers, item amounts) in the entry currency', () => {
		const dto = toTransactionDetailDto(makeDetail());
		expect(dto.amount).toEqual({ amount: 1000, currency: 'USD' });
		expect(dto.payers).toEqual([{ memberId: 'm1', amountPaid: { amount: 1000, currency: 'USD' } }]);
		expect(dto.items[0].amount).toEqual({ amount: 600, currency: 'USD' });
	});

	it('nests settlement-currency amounts (settlement total, shares, item shares) in settlement', () => {
		const dto = toTransactionDetailDto(makeDetail());
		expect(dto.settlementAmount).toEqual({ amount: 35000, currency: 'THB' });
		expect(dto.shares).toEqual([
			{ memberId: 'm1', amountOwed: { amount: 20000, currency: 'THB' } },
			{ memberId: 'm2', amountOwed: { amount: 15000, currency: 'THB' } }
		]);
		expect(dto.items[0].shares).toEqual([
			{ memberId: 'm1', amountOwed: { amount: 10500, currency: 'THB' } }
		]);
	});

	it('keeps a charge `value` as a bare scalar (percent is not money)', () => {
		const dto = toTransactionDetailDto(makeDetail());
		expect(dto.charges).toEqual([
			{ kind: 'vat', mode: 'percent', value: 7, base: 'items_subtotal', sortOrder: 0 },
			{ kind: 'tip', mode: 'absolute', value: 200, base: 'running_total', sortOrder: 1 }
		]);
	});

	it('preserves deletedAt for a soft-deleted transaction', () => {
		const dto = toTransactionDetailDto(makeDetail({ deletedAt: '2026-06-01T00:00:00.000Z' }));
		expect(dto.deletedAt).toBe('2026-06-01T00:00:00.000Z');
	});

	it('carries the scalar identity/view fields through unchanged', () => {
		const dto = toTransactionDetailDto(makeDetail());
		expect(dto.id).toBe('t1');
		expect(dto.groupId).toBe('g1');
		expect(dto.type).toBe('spending');
		expect(dto.title).toBe('Dinner');
		expect(dto.splitMode).toBe('itemized');
		expect(dto.isForeign).toBe(true);
		expect(dto.createdAt).toBe('2026-05-01T10:00:00.000Z');
	});
});
