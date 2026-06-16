import { describe, it, expect } from 'vitest';
import { currencyCodeSchema } from './currency';
import { CURRENCY_CODES } from '../money/currencies';

// Unit tests for the shared currency-code validation enum (PLAN §7.5.1 / #19).

describe('currencyCodeSchema', () => {
	it('accepts every supported code', () => {
		for (const code of CURRENCY_CODES) {
			expect(currencyCodeSchema.safeParse(code).success, code).toBe(true);
		}
	});

	it('accepts USD / THB / JPY', () => {
		expect(currencyCodeSchema.parse('USD')).toBe('USD');
		expect(currencyCodeSchema.parse('THB')).toBe('THB');
		expect(currencyCodeSchema.parse('JPY')).toBe('JPY');
	});

	it('rejects BTC (intentionally excluded — non-fiat)', () => {
		expect(currencyCodeSchema.safeParse('BTC').success).toBe(false);
	});

	it('rejects wrong-case, unknown, and empty input', () => {
		expect(currencyCodeSchema.safeParse('usd').success).toBe(false);
		expect(currencyCodeSchema.safeParse('XXX').success).toBe(false);
		expect(currencyCodeSchema.safeParse('').success).toBe(false);
	});

	it('stays in lockstep with the constant (29 accepted codes)', () => {
		expect(CURRENCY_CODES).toHaveLength(29);
	});
});
