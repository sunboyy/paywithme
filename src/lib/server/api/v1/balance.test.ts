// Unit tests for the v1 Balance DTO mapper (PLAN §16.4, §8.1).
// Asserts the bare internal integer is nested as self-describing settlement money
// and that the sign (creditor / debtor / square) is preserved.

import { describe, it, expect } from 'vitest';
import type { MemberBalance } from '$lib/transactions/balances';
import { toBalanceDto } from './balance';

describe('toBalanceDto', () => {
	it('nests the balance as { amount, currency } in the settlement currency', () => {
		const balance: MemberBalance = { memberId: 'm1', balance: 12345 };
		const dto = toBalanceDto(balance, 'EUR');
		expect(dto).toEqual({
			memberId: 'm1',
			balance: { amount: 12345, currency: 'EUR' }
		});
	});

	it('preserves a negative (debtor) balance', () => {
		const dto = toBalanceDto({ memberId: 'm2', balance: -5000 }, 'USD');
		expect(dto.balance).toEqual({ amount: -5000, currency: 'USD' });
	});

	it('preserves a zero (square) balance', () => {
		const dto = toBalanceDto({ memberId: 'm3', balance: 0 }, 'THB');
		expect(dto.balance).toEqual({ amount: 0, currency: 'THB' });
	});
});
