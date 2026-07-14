// Unit tests for the currency view (ADR-0004): the model is told how many decimals a
// currency takes — never asked to do exponent arithmetic.

import { describe, it, expect } from 'vitest';
import { CURRENCIES } from '$lib/money';
import { toCurrencyViews, CURRENCIES_NOTE } from './currency';

describe('toCurrencyViews', () => {
	it('serves every supported currency (PLAN §7.5.1)', () => {
		expect(toCurrencyViews()).toHaveLength(CURRENCIES.length);
	});

	it('states the DECIMAL PLACES a currency accepts, not an exponent to multiply by', () => {
		const views = toCurrencyViews();

		expect(views.find((c) => c.code === 'THB')).toEqual({
			code: 'THB',
			name: 'Thai Baht',
			symbol: '฿',
			decimalPlaces: 2,
			example: '240.00'
		});
		// A 0-decimal currency: "240.00" would be a hard error, so the example shows why.
		expect(views.find((c) => c.code === 'JPY')).toEqual({
			code: 'JPY',
			name: 'Japanese Yen',
			symbol: '¥',
			decimalPlaces: 0,
			example: '240'
		});
	});

	it('carries the NAME the model can match a user’s words against (REST drops it)', () => {
		expect(toCurrencyViews().every((c) => c.name.length > 0)).toBe(true);
	});

	it('forbids the exponent arithmetic ADR-0004 exists to prevent', () => {
		expect(CURRENCIES_NOTE).toMatch(/decimal string/i);
		expect(CURRENCIES_NOTE).toMatch(/never multiply by 100/i);
	});
});
