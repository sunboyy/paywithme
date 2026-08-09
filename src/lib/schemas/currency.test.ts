import { describe, it, expect } from 'vitest';
import {
	buildEntryCurrencySchema,
	currencyCodeSchema,
	UNSUPPORTED_CURRENCY_MESSAGE
} from './currency';
import { CURRENCY_CODES } from '../money/currencies';

// Unit tests for the shared currency-code validation (PLAN §7.5.1 / #19, and
// §7.5.2 / ADR-0014 for the group-scoped entry gate).
//
// The two gates are tested separately BECAUSE they are separate: `currencyCodeSchema`
// still guards `groups.settlement_currency` and must keep rejecting a custom code,
// while `buildEntryCurrencySchema` is per-group and must accept THAT group's custom
// rows and no one else's.

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

// ─────────────────────────────────────────────────────────────────────────────
// Group-scoped ENTRY-currency gate (PLAN §7.5.2 / ADR-0014).
// ─────────────────────────────────────────────────────────────────────────────

/** This group's own custom currency: opaque PK, user-typed display code. */
const OUR_BEER = { code: 'cur_beer', displayCode: 'BEER', exponent: 0, symbol: '🍺' };
/** ANOTHER group's custom currency — a real row, but not in this group's set. */
const THEIR_BEER = { code: 'cur_other_beer', displayCode: 'BEER', exponent: 0, symbol: '🍺' };

/** What `listCurrenciesForGroup` returns for a group that defined BEER. */
const GROUP_SET = [...CURRENCY_CODES.map((code) => ({ code })), OUR_BEER];

describe('buildEntryCurrencySchema (group-scoped, PLAN §7.5.2)', () => {
	const schema = buildEntryCurrencySchema(GROUP_SET);

	it('accepts every seeded code — the floor is unchanged for every group', () => {
		for (const code of CURRENCY_CODES) {
			expect(schema.safeParse(code).success, code).toBe(true);
		}
	});

	it("accepts THIS group's custom currency by its opaque code", () => {
		expect(schema.parse(OUR_BEER.code)).toBe(OUR_BEER.code);
	});

	it("rejects ANOTHER group's custom code with the shared message", () => {
		const res = schema.safeParse(THEIR_BEER.code);
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error.issues[0].message).toBe(UNSUPPORTED_CURRENCY_MESSAGE);
		}
	});

	it('rejects the DISPLAY code — the picker posts the primary key, not the label', () => {
		// Two groups may both display BEER, so `display_code` can never identify a row.
		expect(schema.safeParse('BEER').success).toBe(false);
	});

	it('rejects unknown, wrong-case and empty codes with the same message', () => {
		for (const bad of ['XXX', 'usd', '', 'BTC']) {
			const res = schema.safeParse(bad);
			expect(res.success, bad).toBe(false);
			if (!res.success) {
				expect(res.error.issues[0].message).toBe(UNSUPPORTED_CURRENCY_MESSAGE);
			}
		}
	});

	it('rejects a non-string', () => {
		expect(schema.safeParse(42).success).toBe(false);
		expect(schema.safeParse(null).success).toBe(false);
	});

	it('a group with no custom currencies accepts exactly the seeded 29', () => {
		const seededOnly = buildEntryCurrencySchema(CURRENCY_CODES.map((code) => ({ code })));
		expect(seededOnly.safeParse('THB').success).toBe(true);
		expect(seededOnly.safeParse(OUR_BEER.code).success).toBe(false);
	});
});

describe('currencyCodeSchema still guards the SETTLEMENT currency alone (ADR-0014 decision 1)', () => {
	it('rejects a custom currency code — it may never be a settlement currency', () => {
		expect(currencyCodeSchema.safeParse(OUR_BEER.code).success).toBe(false);
		expect(currencyCodeSchema.safeParse(OUR_BEER.displayCode).success).toBe(false);
	});

	it('rejects with the same shared message as the entry gate', () => {
		const res = currencyCodeSchema.safeParse('XXX');
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error.issues[0].message).toBe(UNSUPPORTED_CURRENCY_MESSAGE);
		}
	});
});
