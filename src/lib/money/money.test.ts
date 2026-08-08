import { describe, it, expect } from 'vitest';
import {
	scaleFactor,
	parseAmount,
	parseMinor,
	sanitizeAmountInput,
	formatAmount,
	formatMinor,
	symbolPrefix,
	distribute,
	distributeEqually,
	MAX_SAFE_MINOR
} from './money';
import {
	asEntryCurrencyCode,
	getCurrency,
	isCustomCurrency,
	CURRENCY_CODES,
	type CurrencyDescriptor,
	type SeededCurrencyCode
} from './currencies';

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
		expect(() => scaleFactor('XXX' as SeededCurrencyCode)).toThrow();
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
		// No SeededCurrencyCode in the data has exponent 3, so `parseAmount` can't reach a
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

describe('sanitizeAmountInput', () => {
	// The entry-side counterpart to parseAmount: it keeps whatever can still BECOME
	// a valid amount, so a field can render exactly what the user typed without the
	// display drifting away from the value that gets parsed out of it.

	it('keeps a well-formed amount untouched', () => {
		expect(sanitizeAmountInput('12.50', 'THB')).toBe('12.50');
		expect(sanitizeAmountInput('0', 'USD')).toBe('0');
		expect(sanitizeAmountInput('', 'USD')).toBe('');
	});

	it('drops non-numeric junk instead of letting it sit in the field', () => {
		expect(sanitizeAmountInput('12a', 'THB')).toBe('12');
		expect(sanitizeAmountInput('abc', 'THB')).toBe('');
		expect(sanitizeAmountInput('$5', 'USD')).toBe('5');
		expect(sanitizeAmountInput('-5', 'USD')).toBe('5'); // entry is non-negative
		expect(sanitizeAmountInput('1,234', 'USD')).toBe('1234'); // same amount
	});

	it('caps the fraction at the currency exponent as it is typed', () => {
		expect(sanitizeAmountInput('12.345', 'THB')).toBe('12.34');
		expect(sanitizeAmountInput('1.99999', 'USD')).toBe('1.99');
		// Whatever survives must be something parseAmount actually accepts.
		expect(parseAmount(sanitizeAmountInput('12.345', 'THB'), 'THB')).toBe(1234);
	});

	it('allows NO fraction at all for a 0-dp currency', () => {
		expect(sanitizeAmountInput('12.5', 'JPY')).toBe('12');
		expect(sanitizeAmountInput('12.', 'JPY')).toBe('12');
		expect(parseAmount(sanitizeAmountInput('12.5', 'JPY'), 'JPY')).toBe(12);
	});

	it('keeps only the first decimal point', () => {
		expect(sanitizeAmountInput('1.2.3', 'THB')).toBe('1.23');
	});

	it('preserves a trailing point — the midpoint of typing "12.50"', () => {
		expect(sanitizeAmountInput('12.', 'THB')).toBe('12.');
	});

	it('gives a leading point its zero so the result parses', () => {
		expect(sanitizeAmountInput('.5', 'THB')).toBe('0.5');
		expect(parseAmount(sanitizeAmountInput('.5', 'THB'), 'THB')).toBe(50);
	});

	it('is idempotent — re-sanitizing its own output changes nothing', () => {
		for (const raw of ['12.345', 'abc', '.5', '1.2.3', '12.', '-1,000.999']) {
			const once = sanitizeAmountInput(raw, 'THB');
			expect(sanitizeAmountInput(once, 'THB')).toBe(once);
		}
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

	// `{ code: false }` is for surfaces where context already fixes the currency
	// (inside one group), so repeating the ISO code on every row is noise.
	describe('{ code: false } — context-established currency', () => {
		it('drops the ISO code and keeps the bare symbol', () => {
			expect(formatAmount(1000, 'JPY', { code: false })).toBe('¥1,000');
			expect(formatAmount(1250, 'USD', { code: false })).toBe('$12.50');
			expect(formatAmount(123456789, 'USD', { code: false })).toBe('$1,234,567.89');
		});

		it('hoists the sign in front of the symbol', () => {
			expect(formatAmount(-1250, 'USD', { code: false })).toBe('-$12.50');
			expect(formatAmount(-2156000, 'JPY', { code: false })).toBe('-¥2,156,000');
		});

		it('leaves already-unique letter symbols untouched', () => {
			// 'CN¥' starts with a letter and is unique, so the default never
			// code-prefixed it; `code: false` is a no-op for these.
			expect(formatAmount(1000, 'CNY', { code: false })).toBe(formatAmount(1000, 'CNY'));
		});

		it('collapses SEK/NOK to the same string — the caller must supply context', () => {
			// The disambiguation this opt-out gives up: only pass `code: false` where
			// the surrounding UI already states which currency is in play.
			expect(formatAmount(50000, 'SEK', { code: false })).toBe(
				formatAmount(50000, 'NOK', { code: false })
			);
		});

		it('still honours `symbol: false` and `grouped: false`', () => {
			expect(formatAmount(1250, 'USD', { code: false, symbol: false })).toBe('12.50');
			expect(formatAmount(123456789, 'USD', { code: false, grouped: false })).toBe('$1234567.89');
		});
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

	// The whole point of the descriptor overload is that it must not have moved the
	// seeded output by a single byte. This pins the rendering of ALL 29 currencies —
	// the ones whose symbol survives bare (`CN¥`, `HK$`, `CHF`, `zł`, `Kč`, `R`), the
	// ones that get code-prefixed (`USD $`, `JPY ¥`), and the `kr` collision — as
	// literal expected strings, captured from the implementation as it was BEFORE
	// this change. Anything that shifts the prefix rule breaks this list.
	it('renders every seeded currency byte-identically (regression)', () => {
		expect(CURRENCY_CODES.map((c) => `${c}\t${formatAmount(123456789, c)}`)).toEqual([
			'CNY\tCN¥1,234,567.89',
			'USD\tUSD $1,234,567.89',
			'EUR\tEUR €1,234,567.89',
			'JPY\tJPY ¥123,456,789',
			'GBP\tGBP £1,234,567.89',
			'KRW\tKRW ₩123,456,789',
			'HKD\tHK$1,234,567.89',
			'TWD\tNT$1,234,567.89',
			'CAD\tCA$1,234,567.89',
			'RUB\tRUB ₽1,234,567.89',
			'BRL\tR$1,234,567.89',
			'CHF\tCHF1,234,567.89',
			'MXN\tMX$1,234,567.89',
			'INR\tINR ₹1,234,567.89',
			'SAR\tSAR1,234,567.89',
			'AED\tAED1,234,567.89',
			'PLN\tzł1,234,567.89',
			'THB\tTHB ฿1,234,567.89',
			'SGD\tS$1,234,567.89',
			'VND\tVND ₫123,456,789',
			'MYR\tRM1,234,567.89',
			'TRY\tTRY ₺1,234,567.89',
			'IDR\tRp1,234,567.89',
			'SEK\tSEK kr1,234,567.89',
			'ILS\tILS ₪1,234,567.89',
			'NOK\tNOK kr1,234,567.89',
			'CZK\tKč1,234,567.89',
			'PHP\tPHP ₱1,234,567.89',
			'ZAR\tR1,234,567.89'
		]);
	});
});

// ── Resolved currency descriptors (PLAN §7.5.2 / ADR-0014 decision 4) ─────────
// The adapter that lets a GROUP-DEFINED custom currency — a `currencies` row that
// is NOT in the compiled-in constant, so `getCurrency()` can never find it — parse
// and format through the same exponent-driven core. No arithmetic changed; these
// tests police the seam.
describe('currency descriptors', () => {
	/** A custom row as `lib/server` will hand it over: opaque `code`, typed `displayCode`. */
	const custom = (over: Partial<CurrencyDescriptor> = {}): CurrencyDescriptor => ({
		code: 'cur_9f0c2a1e-0000-4000-8000-000000000001',
		displayCode: 'BEER',
		exponent: 2,
		symbol: '🍺',
		...over
	});

	describe('a descriptor behaves exactly like a code at the same exponent', () => {
		it('exponent 0 matches the seeded 0-dp currency (JPY)', () => {
			// Same shape a seeded row has in the DB: `code == display_code`.
			const jpy: CurrencyDescriptor = {
				code: 'JPY',
				displayCode: 'JPY',
				exponent: 0,
				symbol: '¥'
			};
			expect(scaleFactor(jpy)).toBe(scaleFactor('JPY'));
			expect(parseAmount('1,000', jpy)).toBe(parseAmount('1,000', 'JPY'));
			expect(() => parseAmount('1000.5', jpy)).toThrow(/decimal/i);
			expect(sanitizeAmountInput('12.5', jpy)).toBe(sanitizeAmountInput('12.5', 'JPY'));
			expect(formatAmount(1000, jpy)).toBe(formatAmount(1000, 'JPY'));
			expect(formatAmount(-2156000, jpy, { code: false })).toBe(
				formatAmount(-2156000, 'JPY', { code: false })
			);
			// Round-trip: string → minor → string, at the descriptor's own exponent.
			expect(formatAmount(parseAmount('1,000', jpy), jpy, { symbol: false })).toBe('1,000');
		});

		it('exponent 3 works even though no seeded currency has one', () => {
			// The seeded set is all 0-dp or 2-dp, so a 3-dp currency can ONLY arrive as a
			// descriptor (or a future seeded row). It must behave as the exponent-driven
			// core does — `parseMinor`/`formatMinor` at exponent 3 are the reference.
			const kwd = custom({ displayCode: 'KWD', exponent: 3, symbol: 'د.ك' });
			expect(scaleFactor(kwd)).toBe(1000);
			expect(parseAmount('1.234', kwd)).toBe(parseMinor('1.234', 3));
			expect(parseAmount('1.234', kwd)).toBe(1234);
			expect(() => parseAmount('1.2345', kwd)).toThrow(/decimal/i);
			expect(sanitizeAmountInput('1.2345', kwd)).toBe('1.234');
			expect(formatAmount(1234, kwd, { symbol: false })).toBe(formatMinor(1234, 3));
			expect(formatAmount(parseAmount('1.234', kwd), kwd, { symbol: false })).toBe('1.234');
		});

		it('carries the whole parse contract over unchanged', () => {
			const beer = custom();
			expect(() => parseAmount('', beer)).toThrow(/empty/i);
			expect(() => parseAmount('abc', beer)).toThrow(/invalid/i);
			expect(() => parseAmount('-5.00', beer)).toThrow(/negative/i);
			expect(parseAmount('-5.00', beer, { allowNegative: true })).toBe(-500);
			expect(parseAmount(' 1,000.50 ', beer)).toBe(100050);
		});

		it('names the DISPLAY code, never the opaque code, in a parse error', () => {
			expect(() => parseAmount('1.234', custom())).toThrow(/BEER/);
			expect(() => parseAmount('1.234', custom())).not.toThrow(/cur_/);
		});
	});

	describe('a custom currency ALWAYS disambiguates its symbol', () => {
		// `SYMBOL_IS_UNIQUE` is computed over the CLOSED seeded set, so it can say
		// nothing about a member-authored symbol: it may collide with a seeded one, or
		// be a letter-led token that the seeded rule would have passed through bare.
		it('code-prefixes a `$` symbol so it cannot read as USD', () => {
			expect(formatAmount(1250, custom({ displayCode: 'PESO', symbol: '$' }))).toBe('PESO $12.50');
			expect(formatAmount(1250, custom({ displayCode: 'PESO', symbol: '$' }))).not.toBe(
				formatAmount(1250, 'USD')
			);
		});

		it('code-prefixes `kr` even though the seeded rule would pass a letter-led symbol bare', () => {
			// The letter-led-AND-unique branch: `kr` is letter-led but collides (SEK/NOK),
			// and a custom row must not join that collision either.
			expect(formatAmount(50000, custom({ displayCode: 'BREW', symbol: 'kr' }))).toBe(
				'BREW kr500.00'
			);
			expect(symbolPrefix(custom({ displayCode: 'BREW', symbol: 'kr' }))).toBe('BREW kr');
		});

		it('code-prefixes a letter-initial symbol that renders BARE for a seeded row', () => {
			// `CHF` is letter-led and unique in the seeded set, so the seeded rule passes
			// it through bare. The identical symbol on a CUSTOM row is still prefixed —
			// custom-ness, not the symbol's shape, is what decides.
			expect(symbolPrefix('CHF', 'CHF')).toBe('CHF');
			expect(symbolPrefix({ code: 'CHF', displayCode: 'CHF', exponent: 2, symbol: 'CHF' })).toBe(
				'CHF'
			);
			expect(symbolPrefix(custom({ displayCode: 'CHIP', symbol: 'CHF' }))).toBe('CHIP CHF');
			expect(formatAmount(1250, custom({ displayCode: 'CHIP', symbol: 'CHF' }))).toBe(
				'CHIP CHF12.50'
			);
			// A plain letter-led symbol no seeded row uses is prefixed too: absent from
			// the closed set means "not known to be unique", never "unique".
			expect(formatAmount(1250, custom({ symbol: 'B' }))).toBe('BEER B12.50');
		});

		it('cannot be silenced by `{ code: false }` — it is always foreign', () => {
			// The opt-out means "the surrounding UI already fixes the currency", which is
			// never true of an entry-only custom currency (ADR-0014 decision 6).
			expect(formatAmount(1250, custom({ symbol: '$' }), { code: false })).toBe('BEER $12.50');
			expect(formatAmount(-1250, custom({ symbol: '$' }), { code: false })).toBe('BEER $-12.50');
			// `symbol: false` still drops everything but the digits, as for any currency.
			expect(formatAmount(1250, custom(), { code: false, symbol: false })).toBe('12.50');
		});
	});

	describe('the opaque code never reaches a rendered string', () => {
		it('is absent from every option combination', () => {
			const beer = custom();
			for (const opts of [
				undefined,
				{ code: false },
				{ code: true },
				{ symbol: false },
				{ grouped: false },
				{ code: false, grouped: false }
			]) {
				expect(formatAmount(-123456789, beer, opts)).not.toContain('cur_');
			}
			expect(symbolPrefix(beer)).not.toContain('cur_');
		});

		it('refuses to format a custom currency passed as a BARE code', () => {
			// The only way to render one is with its resolved row — a bare opaque code
			// has no exponent and no symbol here, so guessing would be worse than failing.
			expect(() => formatAmount(1250, asEntryCurrencyCode('cur_abc'))).toThrow(/unknown/i);
			expect(() => parseAmount('12.50', asEntryCurrencyCode('cur_abc'))).toThrow(/unknown/i);
		});

		it('rejects a descriptor with no display code to prefix', () => {
			expect(() => formatAmount(1250, custom({ displayCode: '' }))).toThrow(/display code/i);
			expect(() => formatAmount(1250, custom({ displayCode: '   ' }))).toThrow(/display code/i);
		});
	});

	describe('descriptor validation', () => {
		it('rejects a malformed exponent rather than rendering nonsense', () => {
			expect(() => formatAmount(1250, custom({ exponent: -1 }))).toThrow(/exponent/i);
			expect(() => formatAmount(1250, custom({ exponent: 1.5 }))).toThrow(/exponent/i);
			expect(() => parseAmount('1', custom({ exponent: Number.NaN }))).toThrow(/exponent/i);
			expect(() => scaleFactor(custom({ exponent: -1 }))).toThrow(/exponent/i);
		});

		it('rejects an empty primary code', () => {
			expect(() => formatAmount(1250, custom({ code: '' }))).toThrow(/empty code/i);
		});
	});

	describe('asEntryCurrencyCode', () => {
		it('passes a code through and rejects a blank one', () => {
			expect(asEntryCurrencyCode('THB')).toBe('THB');
			expect(asEntryCurrencyCode('cur_abc')).toBe('cur_abc');
			expect(() => asEntryCurrencyCode('')).toThrow(/empty/i);
			expect(() => asEntryCurrencyCode('  ')).toThrow(/empty/i);
		});

		it('keeps a seeded code usable everywhere an entry code is', () => {
			expect(formatAmount(1250, asEntryCurrencyCode('USD'))).toBe(formatAmount(1250, 'USD'));
		});
	});

	describe('isCustomCurrency', () => {
		it('reads the seeded invariant `code == display_code`', () => {
			expect(isCustomCurrency(custom())).toBe(true);
			expect(isCustomCurrency({ code: 'THB', displayCode: 'THB', exponent: 2, symbol: '฿' })).toBe(
				false
			);
		});
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

	it('gives leftover minor units to lowest memberId on a tie (rotation 0)', () => {
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

	// ── Rotated tie-break (ADR-0013) ──────────────────────────────────────────
	// `member_id` is a UUID in production, so "lowest id" is arbitrary AND fixed:
	// without rotation the same member absorbs the leftover minor unit on every
	// unevenly-divisible split for the life of the group.

	it('rotates which tied member takes the leftover unit, one member per step', () => {
		const shares = [
			{ memberId: 3, weight: 1 },
			{ memberId: 1, weight: 1 },
			{ memberId: 2, weight: 1 }
		];
		const takerAt = (rotation: number) =>
			distribute(100, shares, rotation).find((r) => r.amount === 34)?.memberId;

		expect(takerAt(0)).toBe(1);
		expect(takerAt(1)).toBe(2);
		expect(takerAt(2)).toBe(3);
		// Wraps: rotation n returns to the start, so the cycle is exactly n long.
		expect(takerAt(3)).toBe(1);
	});

	it('THE REQUIREMENT: three ฿100 splits three ways charge each member the extra satang once', () => {
		// ฿100 = 10 000 satang across 3 members = 3 333 each, 1 left over. Across three
		// consecutive transactions (ordinals 0/1/2) every member pays ฿33.34 exactly once
		// and ฿33.33 twice, so nobody is systematically out of pocket.
		const memberIds = ['uuid-c', 'uuid-a', 'uuid-b'];
		const paid = new Map<string | number, number[]>(memberIds.map((id) => [id, []]));

		for (let roundingSeq = 0; roundingSeq < 3; roundingSeq++) {
			const out = distributeEqually(10_000, memberIds, roundingSeq);
			expect(sum(out)).toBe(10_000);
			for (const r of out) paid.get(r.memberId)!.push(r.amount);
		}

		for (const amounts of paid.values()) {
			expect(amounts.filter((a) => a === 3334)).toHaveLength(1);
			expect(amounts.filter((a) => a === 3333)).toHaveLength(2);
		}
	});

	it('rotation never overrides a larger remainder — only genuine ties reorder', () => {
		// Weights 1:2:3 over 100 → exact 16.67 / 33.33 / 50. Remainders differ, so the
		// two leftover units are owed to the two largest regardless of rotation: this is
		// why `share`-mode and FX distributions are unaffected in practice.
		const shares = [
			{ memberId: 'a', weight: 1 },
			{ memberId: 'b', weight: 2 },
			{ memberId: 'c', weight: 3 }
		];
		const at0 = distribute(100, shares, 0);
		for (let rotation = 1; rotation < 6; rotation++) {
			expect(distribute(100, shares, rotation)).toEqual(at0);
		}
		expect(sum(at0)).toBe(100);
	});

	it('sums exactly to the total at every rotation, for any weights', () => {
		const shares = [
			{ memberId: 'm1', weight: 1 },
			{ memberId: 'm2', weight: 1 },
			{ memberId: 'm3', weight: 1 },
			{ memberId: 'm4', weight: 1 }
		];
		for (let rotation = -4; rotation <= 8; rotation++) {
			for (const total of [1, 7, 99, 100, 1001, -7]) {
				const out = distribute(total, shares, rotation);
				expect(sum(out)).toBe(total);
			}
		}
	});

	it('handles a negative total (discount) with the same rotation', () => {
		const shares = [
			{ memberId: 'a', weight: 1 },
			{ memberId: 'b', weight: 1 },
			{ memberId: 'c', weight: 1 }
		];
		// Magnitude split 34/33/33 then negated; rotation 1 moves the extra to 'b'.
		const out = distribute(-100, shares, 1);
		expect(Object.fromEntries(out.map((r) => [r.memberId, r.amount]))).toEqual({
			a: -33,
			b: -34,
			c: -33
		});
		expect(sum(out)).toBe(-100);
	});

	it('rejects a non-integer rotation rather than silently flooring it', () => {
		const shares = [
			{ memberId: 'a', weight: 1 },
			{ memberId: 'b', weight: 1 }
		];
		expect(() => distribute(10, shares, 1.5)).toThrow(/rotation must be a safe integer/i);
		expect(() => distribute(10, shares, NaN)).toThrow(/rotation must be a safe integer/i);
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
