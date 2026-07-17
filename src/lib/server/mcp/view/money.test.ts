// Unit tests for agent-facing money (ADR-0004): decimal strings, per-currency
// precision, and the sign of a debt.

import { describe, it, expect } from 'vitest';
import { toMcpMoney } from './money';

describe('toMcpMoney', () => {
	it('renders a 2-decimal currency in ORDINARY units — 24000 minor → "240.00"', () => {
		// The failure this prevents: the model reads `24000` and says "twenty-four
		// thousand baht", or writes `240` back and records ฿2.40.
		expect(toMcpMoney(24000, 'THB')).toEqual({
			amount: '240.00',
			currency: 'THB',
			display: 'THB ฿240.00'
		});
	});

	it('renders a 0-decimal currency with NO decimal point — JPY 240 minor → "240"', () => {
		// The same utterance ("240") is a DIFFERENT integer per currency. The exponent
		// math stays here, on the server, where it is table-driven.
		expect(toMcpMoney(240, 'JPY')).toEqual({
			amount: '240',
			currency: 'JPY',
			display: 'JPY ¥240'
		});
	});

	it('keeps the SIGN of a debt: a negative balance renders "-1200.00"', () => {
		const money = toMcpMoney(-120000, 'THB');
		expect(money.amount).toBe('-1200.00');
		expect(money.display).toBe('THB ฿-1,200.00');
	});

	it('renders zero as the currency’s zero, not an empty string', () => {
		expect(toMcpMoney(0, 'USD').amount).toBe('0.00');
		expect(toMcpMoney(0, 'JPY').amount).toBe('0');
	});

	it('`amount` is UNGROUPED, so it round-trips straight back into a write tool', () => {
		const money = toMcpMoney(123456789, 'USD');
		expect(money.amount).toBe('1234567.89');
		// The grouped form exists too — for QUOTING, not for feeding back in.
		expect(money.display).toBe('USD $1,234,567.89');
	});

	it('never emits a float or a bare integer — `amount` is always a string', () => {
		for (const minor of [1, 0, -1, 999_999]) {
			expect(typeof toMcpMoney(minor, 'THB').amount).toBe('string');
		}
	});
});
