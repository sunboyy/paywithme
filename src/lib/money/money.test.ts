import { describe, it, expect } from 'vitest';
import {
	scaleFactor,
	parseAmount,
	parseMinor,
	formatAmount,
	formatMinor,
	symbolPrefix,
	distribute,
	distributeEqually,
	MAX_SAFE_MINOR
} from './money';
import { getCurrency, CURRENCY_CODES, type CurrencyCode } from './currencies';

// Unit tests for the currency-aware money helper (PLAN §7.5 / §7.2 / §7.6).
// They prove: per-currency precision is read from the exponent (never hardcoded),
// arbitrary exponents 0–3 work, parse round-trips & rejections hold, the
// largest-remainder split sums EXACTLY and breaks ties by ascending memberId, and
// the symbol-disambiguation rule makes different currencies render distinct
// strings.

describe('scaleFactor', () => {
	it('is 10**exponent per currency, read from the data not a literal', () => {
		expect(scaleFactor('JPY')).toBe(1); // exponent 0
		expect(scaleFactor('USD')).toBe(100); // exponent 2
		expect(scaleFactor('THB')).toBe(100);
		// Cross-check it tracks the stored exponent exactly, for every currency.
		expect(scaleFactor('VND')).toBe(10 ** getCurrency('VND')!.exponent);
	});

	it('throws on an unknown currency', () => {
		expect(() => scaleFactor('XXX' as CurrencyCode)).toThrow();
	});
});

describe('parseAmount', () => {
	it('parses 2-dp currencies into minor units', () => {
		expect(parseAmount('12.50', 'USD')).toBe(1250);
		expect(parseAmount('0.01', 'THB')).toBe(1);
		expect(parseAmount('100', 'USD')).toBe(10000); // no decimal point → whole units
		expect(parseAmount('1.5', 'EUR')).toBe(150); // single decimal padded
	});

	it('parses 0-dp currencies with no fractional digits allowed', () => {
		expect(parseAmount('1000', 'JPY')).toBe(1000);
		expect(parseAmount('1000', 'KRW')).toBe(1000);
		expect(parseAmount('250', 'VND')).toBe(250);
		expect(() => parseAmount('1000.5', 'JPY')).toThrow(/decimal/i);
		expect(() => parseAmount('10.0', 'KRW')).toThrow(/decimal/i);
	});

	it('honours an arbitrary exponent-3 currency through the real code path', () => {
		// No CurrencyCode in the data has exponent 3, so `parseAmount` can't reach a
		// 3-dp path. Drive the exponent-driven core (`parseMinor`, which `parseAmount`
		// delegates to) directly at exponent 3 — the SAME production code, just with
		// the exponent injected rather than resolved from a code. This proves the
		// helper scales by the *given* exponent with no hardcoded "2 vs 0" branch.
		expect(parseMinor('1.234', 3)).toBe(1234);
		// And it enforces the supplied exponent as the decimal-place ceiling.
		expect(() => parseMinor('1.2345', 3)).toThrow(/decimal/i);

		// Round-trip at exponent 3: parse → minor → format → original string.
		expect(formatMinor(1234, 3, false)).toBe('1.234');
		const minor = parseMinor('1.234', 3);
		expect(formatMinor(minor, 3, false)).toBe('1.234');

		// The same core also covers exponents 0 and 2 identically, confirming the
		// public functions' behaviour is just this core with a resolved exponent.
		expect(parseMinor('1000', 0)).toBe(1000); // 0-dp: no fractional digits
		expect(() => parseMinor('10.0', 0)).toThrow(/decimal/i);
		expect(parseMinor('12.50', 2)).toBe(1250); // matches parseAmount('12.50','USD')
		expect(formatMinor(1250, 2)).toBe('12.50');
	});

	it('strips thousands separators', () => {
		expect(parseAmount('1,000', 'JPY')).toBe(1000);
		expect(parseAmount('1,234,567', 'JPY')).toBe(1234567);
		expect(parseAmount('1,000.50', 'USD')).toBe(100050);
	});

	it('trims surrounding whitespace', () => {
		expect(parseAmount('  12.50  ', 'USD')).toBe(1250);
	});

	it('round-trips with formatAmount', () => {
		for (const [code, str] of [
			['USD', '1,234.56'],
			['JPY', '1,000'],
			['THB', '0.99']
		] as const) {
			const minor = parseAmount(str, code);
			expect(formatAmount(minor, code, { symbol: false })).toBe(str);
		}
	});

	it('rejects empty / whitespace-only input', () => {
		expect(() => parseAmount('', 'USD')).toThrow(/empty/i);
		expect(() => parseAmount('   ', 'USD')).toThrow(/empty/i);
	});

	it('rejects non-numeric junk and malformed separators', () => {
		expect(() => parseAmount('abc', 'USD')).toThrow(/invalid/i);
		expect(() => parseAmount('1.2.3', 'USD')).toThrow(/invalid/i);
		expect(() => parseAmount('$5', 'USD')).toThrow(/invalid/i);
		expect(() => parseAmount('1,,0', 'USD')).toThrow(/invalid/i);
		expect(() => parseAmount('1e3', 'USD')).toThrow(/invalid/i);
		expect(() => parseAmount('Infinity', 'USD')).toThrow(/invalid/i);
	});

	it('rejects too many decimal places for the currency', () => {
		expect(() => parseAmount('1.234', 'USD')).toThrow(/decimal/i);
		expect(() => parseAmount('1.999', 'THB')).toThrow(/decimal/i);
	});

	it('rejects negatives unless explicitly allowed', () => {
		expect(() => parseAmount('-5.00', 'USD')).toThrow(/negative/i);
		expect(parseAmount('-5.00', 'USD', { allowNegative: true })).toBe(-500);
		expect(parseAmount('-1000', 'JPY', { allowNegative: true })).toBe(-1000);
	});

	it('rejects amounts beyond the safe-integer range', () => {
		// MAX_SAFE_INTEGER for USD in major units, +1 minor unit over.
		const huge = '99999999999999999999';
		expect(() => parseAmount(huge, 'USD')).toThrow(/range/i);
	});

	it('accepts the largest safe value', () => {
		expect(MAX_SAFE_MINOR).toBe(Number.MAX_SAFE_INTEGER);
		expect(parseAmount(String(Number.MAX_SAFE_INTEGER), 'JPY')).toBe(Number.MAX_SAFE_INTEGER);
	});
});

describe('formatAmount', () => {
	it('renders 2-dp currencies at 2 decimals', () => {
		expect(formatAmount(1250, 'USD')).toBe('USD $12.50');
		expect(formatAmount(1, 'THB')).toBe('THB ฿0.01');
		expect(formatAmount(0, 'USD')).toBe('USD $0.00');
	});

	it('renders 0-dp currencies with no decimal point', () => {
		expect(formatAmount(1000, 'JPY')).toBe('JPY ¥1,000');
		expect(formatAmount(250, 'VND')).toBe('VND ₫250');
		expect(formatAmount(1000, 'KRW')).toBe('KRW ₩1,000');
	});

	it('groups the integer part with thousands separators', () => {
		expect(formatAmount(123456789, 'USD')).toBe('USD $1,234,567.89');
		expect(formatAmount(1234567, 'JPY')).toBe('JPY ¥1,234,567');
	});

	it('can omit grouping and the symbol', () => {
		expect(formatAmount(123456789, 'USD', { grouped: false })).toBe('USD $1234567.89');
		expect(formatAmount(1250, 'USD', { symbol: false })).toBe('12.50');
		expect(formatAmount(1000, 'JPY', { symbol: false })).toBe('1,000');
	});

	it('renders negative amounts with a leading minus before the digits', () => {
		expect(formatAmount(-1250, 'USD')).toBe('USD $-12.50');
		expect(formatAmount(-500, 'SEK')).toBe('SEK kr-5.00');
	});

	it('throws on a non-integer minor amount', () => {
		expect(() => formatAmount(12.5, 'USD')).toThrow();
	});
});

describe('symbol disambiguation (PLAN §7.5.1)', () => {
	it('makes SEK and NOK (both stored "kr") render distinct strings', () => {
		const sek = formatAmount(50000, 'SEK');
		const nok = formatAmount(50000, 'NOK');
		expect(sek).toBe('SEK kr500.00');
		expect(nok).toBe('NOK kr500.00');
		expect(sek).not.toBe(nok);
	});

	it('makes JPY and CNY (the ¥ family) render distinct strings', () => {
		const jpy = formatAmount(1000, 'JPY'); // bare '¥' → code-prefixed, 0-dp
		const cny = formatAmount(1000, 'CNY'); // pre-disambiguated 'CN¥', unique, 2-dp
		expect(jpy).toBe('JPY ¥1,000');
		expect(cny).toBe('CN¥10.00');
		expect(symbolPrefix('JPY', '¥')).toBe('JPY ¥');
		expect(symbolPrefix('CNY', 'CN¥')).toBe('CN¥');
		expect(symbolPrefix('JPY', '¥')).not.toBe(symbolPrefix('CNY', 'CN¥'));
	});

	it('keeps a unique letter-prefixed symbol as-is, code-prefixes bare glyphs', () => {
		expect(symbolPrefix('HKD', 'HK$')).toBe('HK$'); // unique, letter-led
		expect(symbolPrefix('CHF', 'CHF')).toBe('CHF');
		expect(symbolPrefix('USD', '$')).toBe('USD $'); // bare glyph → code-prefixed
		expect(symbolPrefix('GBP', '£')).toBe('GBP £');
	});

	it('never renders two different currencies as an identical prefix', () => {
		// Iterate EVERY supported currency (incl. the R-family ZAR `R` / BRL `R$` /
		// IDR `Rp`, MYR `RM`, CHF/SAR/AED) — the disambiguated prefix must be unique
		// across the whole set, guarding against any future colliding-prefix regression.
		const prefixes = CURRENCY_CODES.map((c) => symbolPrefix(c, getCurrency(c)!.symbol));
		expect(new Set(prefixes).size).toBe(CURRENCY_CODES.length);
	});
});

describe('distribute (largest-remainder, PLAN §7.2)', () => {
	const sum = (rows: { amount: number }[]) => rows.reduce((s, r) => s + r.amount, 0);

	it('splits evenly when divisible', () => {
		const out = distribute(900, [
			{ memberId: 1, weight: 1 },
			{ memberId: 2, weight: 1 },
			{ memberId: 3, weight: 1 }
		]);
		expect(out.map((r) => r.amount)).toEqual([300, 300, 300]);
		expect(sum(out)).toBe(900);
	});

	it('gives leftover minor units to lowest memberId on a tie', () => {
		// 100 / 3 = 33 each, remainder 1; all remainders equal → goes to lowest id.
		const out = distribute(100, [
			{ memberId: 3, weight: 1 },
			{ memberId: 1, weight: 1 },
			{ memberId: 2, weight: 1 }
		]);
		const byId = Object.fromEntries(out.map((r) => [r.memberId, r.amount]));
		expect(byId).toEqual({ 1: 34, 2: 33, 3: 33 });
		expect(sum(out)).toBe(100);
	});

	it('distributes several leftover units across the largest remainders', () => {
		// total 10 across weights 1,1,1,1 → 2 each (8), remainder 2 → ids 1,2 get +1.
		const out = distribute(10, [
			{ memberId: 4, weight: 1 },
			{ memberId: 2, weight: 1 },
			{ memberId: 1, weight: 1 },
			{ memberId: 3, weight: 1 }
		]);
		const byId = Object.fromEntries(out.map((r) => [r.memberId, r.amount]));
		expect(byId).toEqual({ 1: 3, 2: 3, 3: 2, 4: 2 });
		expect(sum(out)).toBe(10);
	});

	it('respects weights (share split) and rounds remainders by largest fraction', () => {
		// total 100, weights 1:2:1 → exact 25 / 50 / 25, sums to 100.
		const out = distribute(100, [
			{ memberId: 1, weight: 1 },
			{ memberId: 2, weight: 2 },
			{ memberId: 3, weight: 1 }
		]);
		expect(out.map((r) => r.amount)).toEqual([25, 50, 25]);
		expect(sum(out)).toBe(100);
	});

	it('picks the larger remainder before falling back to the id tie-break', () => {
		// total 100, weights 1:1:1 won't show fraction ordering; use 7 across 1:1:1
		// → base 2 each (6), remainders all 1/3 equal → ids 1,2 get the 1 leftover...
		// Instead use weights that produce *different* remainders:
		// total 10, weights 3:3:4 → exact 3, 3, 4 ⇒ no remainder.
		// Use total 10, weights 1:1:1 → base 3 each (9), remainder 1 → lowest id.
		const out = distribute(10, [
			{ memberId: 2, weight: 1 },
			{ memberId: 1, weight: 1 },
			{ memberId: 3, weight: 1 }
		]);
		const byId = Object.fromEntries(out.map((r) => [r.memberId, r.amount]));
		expect(byId).toEqual({ 1: 4, 2: 3, 3: 3 });

		// Now a genuine differing-remainder case: total 5, weights 1:2 →
		// exact 1.667 / 3.333 → bases 1 / 3, remainders 2/3 vs 1/3 → id-2 (weight 2)
		// has the larger remainder and gets the leftover, beating the id tie-break.
		const out2 = distribute(5, [
			{ memberId: 1, weight: 1 },
			{ memberId: 2, weight: 2 }
		]);
		expect(Object.fromEntries(out2.map((r) => [r.memberId, r.amount]))).toEqual({ 1: 2, 2: 3 });
		expect(sum(out2)).toBe(5);
	});

	it('handles a negative total (discount allocation) summing exactly', () => {
		const out = distribute(-100, [
			{ memberId: 1, weight: 1 },
			{ memberId: 2, weight: 1 },
			{ memberId: 3, weight: 1 }
		]);
		expect(sum(out)).toBe(-100);
		const byId = Object.fromEntries(out.map((r) => [r.memberId, r.amount]));
		// magnitude split 34/33/33 then negated; lowest id still takes the extra.
		expect(byId).toEqual({ 1: -34, 2: -33, 3: -33 });
	});

	it('breaks string/UUID-style id ties lexicographically ascending', () => {
		const out = distribute(100, [
			{ memberId: 'c', weight: 1 },
			{ memberId: 'a', weight: 1 },
			{ memberId: 'b', weight: 1 }
		]);
		const byId = Object.fromEntries(out.map((r) => [r.memberId, r.amount]));
		expect(byId).toEqual({ a: 34, b: 33, c: 33 });
	});

	it('returns all zeros for a zero total across zero weight', () => {
		const out = distribute(0, [
			{ memberId: 1, weight: 0 },
			{ memberId: 2, weight: 0 }
		]);
		expect(out.map((r) => r.amount)).toEqual([0, 0]);
	});

	it('throws on empty beneficiaries, negative weight, or non-zero/zero-weight', () => {
		expect(() => distribute(100, [])).toThrow(/zero beneficiaries/i);
		expect(() => distribute(100, [{ memberId: 1, weight: -1 }])).toThrow(/non-negative/i);
		expect(() => distribute(100, [{ memberId: 1, weight: 0 }])).toThrow(/zero total weight/i);
	});

	it('throws on a non-integer total', () => {
		expect(() => distribute(10.5, [{ memberId: 1, weight: 1 }])).toThrow(/integer/i);
	});

	// Property-style: across many totals and weightings the result ALWAYS sums to
	// total and never produces a negative share for a positive total.
	it('always sums exactly to total (property sweep)', () => {
		const totals = [0, 1, 7, 33, 100, 101, 999, 1000, 123457];
		const weightSets = [
			[1, 1, 1],
			[1, 2, 3],
			[5, 5, 5, 5],
			[1, 1, 1, 1, 1, 1, 1],
			[2, 3, 5, 7],
			[10, 1]
		];
		for (const total of totals) {
			for (const weights of weightSets) {
				const shares = weights.map((w, i) => ({ memberId: i + 1, weight: w }));
				const out = distribute(total, shares);
				expect(
					out.reduce((s, r) => s + r.amount, 0),
					`total=${total} w=${weights}`
				).toBe(total);
				for (const r of out) {
					expect(r.amount).toBeGreaterThanOrEqual(0);
				}
			}
		}
	});
});

describe('distributeEqually', () => {
	it('is an equal-weight distribute with the same tie-break', () => {
		const out = distributeEqually(100, [3, 1, 2]);
		const byId = Object.fromEntries(out.map((r) => [r.memberId, r.amount]));
		expect(byId).toEqual({ 1: 34, 2: 33, 3: 33 });
		expect(out.reduce((s, r) => s + r.amount, 0)).toBe(100);
	});

	it('splits a JPY total (0-dp) with no fractional minor units', () => {
		const out = distributeEqually(parseAmount('1000', 'JPY'), [1, 2, 3]);
		const byId = Object.fromEntries(out.map((r) => [r.memberId, r.amount]));
		expect(byId).toEqual({ 1: 334, 2: 333, 3: 333 });
	});
});
