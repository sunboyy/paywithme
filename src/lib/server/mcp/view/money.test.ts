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

	it('marks nothing as custom for one of the seeded 29', () => {
		// `isCustom` is ABSENT, not `false` — its presence is the whole signal, and a
		// `false` on every ordinary amount would train a model to stop reading it.
		expect(toMcpMoney(24000, 'THB')).not.toHaveProperty('isCustom');
	});
});

// ── A group-defined custom entry currency (PLAN §7.5.2, ADR-0014 decision 7) ──
// The opaque `code` is the `currencies` primary key. Emitting it would put an
// internal identifier on the wire in place of the code the member actually chose,
// so this surface resolves the descriptor and emits `display_code`.

/** A 0-decimal custom currency, as `lib/server/entry-currency.ts` resolves it. */
const BEER = {
	code: 'cur_9f2e5a10-0000-4000-8000-000000000001',
	displayCode: 'BEER',
	exponent: 0,
	symbol: '🍺'
};

describe('toMcpMoney — a group-defined custom currency (ADR-0014 decision 7)', () => {
	it('emits the DISPLAY code and never the opaque row key', () => {
		const money = toMcpMoney(3, BEER);

		expect(money.currency).toBe('BEER');
		expect(money.amount).toBe('3');
		// The opaque code appears NOWHERE in the payload — the acceptance criterion.
		expect(JSON.stringify(money)).not.toContain('cur_');
	});

	it('marks the amount `isCustom: true`, so the code is never read as ISO 4217', () => {
		expect(toMcpMoney(3, BEER).isCustom).toBe(true);
	});

	it('formats at the CUSTOM exponent, not a hardcoded 2', () => {
		// A 0-decimal custom unit renders "3", exactly as JPY does. Getting this from the
		// resolved row is why a bare code cannot be passed.
		expect(toMcpMoney(3, BEER).amount).toBe('3');
		expect(toMcpMoney(1234, { ...BEER, exponent: 3 }).amount).toBe('1.234');
	});

	it('ALWAYS disambiguates the display in a custom currency (§7.5.2)', () => {
		// A member-authored symbol is not in the seeded uniqueness map and may be `$`, so
		// the display code is always prefixed — `BEER 🍺3`, never a bare `🍺3`.
		expect(toMcpMoney(3, BEER).display).toBe('BEER 🍺3');
		expect(
			toMcpMoney(500, { ...BEER, displayCode: 'NZD2', symbol: '$', exponent: 2 }).display
		).toBe('NZD2 $5.00');
	});

	it('REFUSES a bare custom code rather than emitting it', () => {
		// The failure mode of a caller that forgets to resolve the row is a THROW, never a
		// leak: `formatAmount` cannot find the code in the compiled-in seeded table.
		expect(() => toMcpMoney(3, BEER.code as never)).toThrow(/Unknown currency code/);
	});
});
