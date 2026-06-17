// Currency-aware money primitives (PLAN §7.5 / §7.2 / §7.6 — task 4.1).
//
// This is the single, shared money math layer every later transaction / split /
// charge / FX task (4.5, 4.8, 4.9, 4.10, 5.x) calls. It does THREE things:
//
//   1. parse   — a major-unit display string (what a user types, e.g. "12.50")
//                → integer **minor units** for the given currency.
//   2. format  — integer minor units → a display string at the currency's own
//                decimal precision, prefixed with a disambiguated symbol.
//   3. distribute — split an integer total across beneficiaries by weight using
//                **largest-remainder** rounding, with leftover minor units broken
//                by ascending `member_id`, so shares sum EXACTLY to the total.
//
// All per-currency precision is read from `getCurrency(code).exponent`
// (`currencies.ts`, the single source of truth) — NEVER hardcoded "×100" / "2 dp".
// A currency's scale factor is `10 ** exponent`: JPY/KRW/VND = 1 (0 dp),
// THB/USD/EUR = 100 (2 dp), and a future 3-decimal currency (KWD) = 1000 (3 dp)
// works with no code change here.
//
// ── Numeric type decision: minor units are plain `number` (not `bigint`) ──
// Minor units are integers, and JS numbers are exact for integers up to
// `Number.MAX_SAFE_INTEGER` (2^53 − 1 ≈ 9.007e15). Even at exponent 3 that is
// ~9.0e12 in major units — over nine trillion of the largest-denominated
// currency in one amount — far beyond any realistic group expense. So `number`
// stays exact for every value this app handles while keeping arithmetic, Drizzle
// `integer`/`bigint` columns, JSON, and Zod simple (no `bigint` serialization
// friction). We guard the boundary: parsing rejects anything that would exceed
// the safe-integer range, so an unrepresentable amount can never silently appear.

import { CURRENCIES, getCurrency, type CurrencyCode } from './currencies';

/**
 * The largest minor-unit magnitude we accept. Equal to `Number.MAX_SAFE_INTEGER`
 * — beyond this, integer `number` math is no longer exact, so we reject at the
 * parse boundary rather than risk a silently-wrong amount.
 */
export const MAX_SAFE_MINOR = Number.MAX_SAFE_INTEGER;

/**
 * `10 ** exponent` for `code` — the factor between one major unit and its minor
 * units (1 for 0-dp currencies, 100 for 2-dp, 1000 for 3-dp). Reads the stored
 * exponent so precision is always per-currency.
 *
 * @throws if `code` is not a supported currency.
 */
export function scaleFactor(code: CurrencyCode): number {
	return 10 ** exponentOf(code);
}

/** Resolve a currency's minor-unit exponent, throwing on an unknown code. */
function exponentOf(code: CurrencyCode): number {
	const currency = getCurrency(code);
	if (currency === undefined) {
		throw new Error(`Unknown currency code: ${String(code)}`);
	}
	return currency.exponent;
}

/** Options for {@link parseAmount}. */
export interface ParseAmountOptions {
	/**
	 * Allow a leading `-` (a negative amount). Defaults to `false` — most entry
	 * points (a spending total, an item price) must be non-negative; callers that
	 * model signed values (e.g. an adjustment) opt in explicitly.
	 */
	readonly allowNegative?: boolean;
}

/**
 * Parse a user-entered **major-unit** string into integer **minor units** for
 * `code`, using that currency's own exponent (no hardcoded dp).
 *
 * Accepts an optional sign, ASCII thousands separators (`,`), and a decimal
 * point with AT MOST `exponent` fractional digits. Surrounding whitespace is
 * trimmed. The result is an exact integer count of minor units.
 *
 * Rejects (throws `Error`) on:
 *   - empty / whitespace-only input;
 *   - non-numeric junk (`"abc"`, `"1.2.3"`, `"$5"`, stray separators like `"1,,0"`);
 *   - more fractional digits than the currency allows (e.g. `"1.234"` for USD,
 *     or any decimals at all for JPY) — we never silently round away precision
 *     the user typed;
 *   - a negative value when `allowNegative` is not set;
 *   - a magnitude that would exceed {@link MAX_SAFE_MINOR}.
 *
 * @example parseAmount('12.50', 'USD') // → 1250
 * @example parseAmount('1,000', 'JPY') // → 1000
 * @example parseAmount('1.234', 'KWD') // → 1234 (3-dp currency)
 */
export function parseAmount(input: string, code: CurrencyCode, opts?: ParseAmountOptions): number {
	return parseMinor(input, exponentOf(code), { ...opts, code });
}

/** Options for {@link parseMinor} — {@link ParseAmountOptions} plus a label for errors. */
interface ParseMinorOptions extends ParseAmountOptions {
	/** A label (typically the ISO code) for the "too many decimal places" message. */
	readonly code?: string;
}

/**
 * Exponent-driven core of {@link parseAmount}, package-private so the public
 * function (which resolves the exponent from a {@link CurrencyCode}) and the unit
 * tests can both drive ANY exponent — including values not present in the
 * currency data, e.g. a 3-decimal currency — through the identical production
 * code path. `parseAmount` delegates here; behaviour is unchanged.
 */
export function parseMinor(input: string, exponent: number, opts?: ParseMinorOptions): number {
	const allowNegative = opts?.allowNegative ?? false;
	const label = opts?.code ?? `exponent ${exponent}`;

	if (typeof input !== 'string') {
		throw new Error('Amount must be a string');
	}
	const trimmed = input.trim();
	if (trimmed === '') {
		throw new Error('Amount is empty');
	}

	// Structural shape: optional sign, digits (with optional comma groups), and an
	// optional fractional part. Reject anything else up front so junk can't slip
	// through Number() coercion (which would accept e.g. "1e3" or "Infinity").
	const match = /^(?<sign>[+-]?)(?<int>\d{1,3}(?:,\d{3})*|\d+)(?:\.(?<frac>\d+))?$/.exec(trimmed);
	if (match?.groups === undefined) {
		throw new Error(`Invalid amount: ${input}`);
	}

	const sign = match.groups.sign === '-' ? -1 : 1;
	const intDigits = match.groups.int.replace(/,/g, '');
	const fracDigits = match.groups.frac ?? '';

	if (fracDigits.length > exponent) {
		throw new Error(
			`Too many decimal places for ${label}: "${input}" has ${fracDigits.length}, max ${exponent}`
		);
	}

	if (sign === -1 && !allowNegative) {
		throw new Error(`Negative amount not allowed: ${input}`);
	}

	// Pad the fractional part out to the full exponent, then concatenate: the whole
	// thing is now an integer count of minor units. String assembly (rather than
	// `value * 10 ** exponent`) avoids any float multiplication entirely.
	const paddedFrac = fracDigits.padEnd(exponent, '0');
	const minorDigits = `${intDigits}${paddedFrac}`.replace(/^0+(?=\d)/, '');
	const minor = sign * Number(minorDigits);

	if (!Number.isSafeInteger(minor)) {
		throw new Error(`Amount out of safe range: ${input}`);
	}
	return minor;
}

/** Options for {@link formatAmount}. */
export interface FormatAmountOptions {
	/**
	 * Include the currency symbol (default `true`). When `false`, only the numeric
	 * portion is rendered at the right dp — handy for input fields or tables with a
	 * separate currency column.
	 */
	readonly symbol?: boolean;
	/**
	 * Insert ASCII thousands separators in the integer part (default `true`).
	 */
	readonly grouped?: boolean;
}

/**
 * Format integer **minor units** into a display string at `code`'s own decimal
 * precision, with a disambiguated symbol.
 *
 * ── Symbol composition rule (PLAN §7.5.1 symbol disambiguation) ──
 * Many world currencies share a glyph (`kr` for SEK & NOK, `¥` for JPY & CNY,
 * the whole `$` family). To guarantee two amounts in *different* currencies never
 * render an identical string, we compose the prefix like this:
 *
 *   - If the stored symbol already starts with letters that uniquely identify the
 *     currency (it begins with an ASCII letter, e.g. `CN¥`, `HK$`, `S$`, `CHF`,
 *     `RM`, `kr`, `zł`), AND that symbol is unique across all currencies, use it
 *     as-is.
 *   - Otherwise — the symbol collides with another currency's symbol (e.g. SEK vs
 *     NOK both `kr`) OR it is a bare non-letter glyph (`¥`, `$`, `£`, `€`, `฿`,
 *     `₩`, …) — we PREFIX the ISO code: `SEK kr`, `NOK kr`, `USD $`, `JP¥`/`JPY`.
 *
 * In practice the existing data pre-disambiguates most collisions (CNY=`CN¥`,
 * HK$, NT$, CA$, MX$, S$), leaving SEK/NOK (`kr`) which this rule splits into
 * `SEK kr` / `NOK kr`. The bare-glyph branch additionally code-prefixes pure
 * symbols like `¥` (JPY) so JPY can never collide with a future bare-`¥` row, and
 * makes every formatted amount self-identifying.
 *
 * @example formatAmount(1250, 'USD') // → 'USD $12.50'  (bare '$' → code-prefixed)
 * @example formatAmount(1000, 'JPY') // → 'JPY ¥1,000'  (0 dp, bare glyph)
 * @example formatAmount(50000, 'SEK') // → 'SEK kr500.00'
 * @example formatAmount(50000, 'NOK') // → 'NOK kr500.00' (distinct from SEK)
 */
export function formatAmount(
	minor: number,
	code: CurrencyCode,
	opts?: FormatAmountOptions
): string {
	if (!Number.isSafeInteger(minor)) {
		throw new Error(`Minor amount must be a safe integer: ${minor}`);
	}
	const currency = getCurrency(code);
	if (currency === undefined) {
		throw new Error(`Unknown currency code: ${String(code)}`);
	}
	const { exponent, symbol } = currency;
	const withSymbol = opts?.symbol ?? true;
	const grouped = opts?.grouped ?? true;

	const numeric = formatMinor(minor, exponent, grouped);

	if (!withSymbol) {
		return numeric;
	}
	return `${symbolPrefix(code, symbol)}${numeric}`;
}

/**
 * Exponent-driven core of {@link formatAmount}: render integer `minor` units as
 * the numeric (symbol-less) display string at `exponent` decimal places, with
 * optional thousands grouping. Package-private so the public formatter and the
 * unit tests can both exercise ANY exponent — including a 3-decimal currency not
 * present in the data — through the identical production path. `formatAmount`
 * delegates here for the numeric portion; behaviour is unchanged.
 */
export function formatMinor(minor: number, exponent: number, grouped = true): string {
	if (!Number.isSafeInteger(minor)) {
		throw new Error(`Minor amount must be a safe integer: ${minor}`);
	}
	const negative = minor < 0;
	const absMinor = Math.abs(minor);

	// Split into integer + fractional minor digits using string slicing (no float
	// division), so precision is exact at any exponent.
	const digits = String(absMinor).padStart(exponent + 1, '0');
	const intPart = digits.slice(0, digits.length - exponent);
	const fracPart = exponent > 0 ? digits.slice(digits.length - exponent) : '';

	const groupedInt = grouped ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : intPart;
	return `${negative ? '-' : ''}${groupedInt}${fracPart === '' ? '' : `.${fracPart}`}`;
}

/**
 * Compose the display prefix for `code` given its stored `symbol`, applying the
 * disambiguation rule documented on {@link formatAmount}. Exported for tests and
 * any UI that needs the prefix on its own.
 *
 * A symbol is used bare only when it (a) begins with an ASCII letter — i.e. it is
 * already a code-like token such as `CN¥`, `HK$`, `CHF`, `kr` — AND (b) is unique
 * across all currencies. Bare glyphs and colliding symbols get `"<CODE> "`
 * prefixed.
 */
export function symbolPrefix(code: CurrencyCode, symbol: string): string {
	const startsWithLetter = /^[A-Za-z]/.test(symbol);
	const unique = SYMBOL_IS_UNIQUE.get(symbol) ?? false;
	if (startsWithLetter && unique) {
		return symbol;
	}
	return `${code} ${symbol}`;
}

/**
 * Map of stored symbol → whether exactly one currency uses it. Built once so the
 * disambiguation rule can detect collisions (SEK/NOK `kr`) at O(1).
 */
const SYMBOL_IS_UNIQUE: ReadonlyMap<string, boolean> = (() => {
	const counts = new Map<string, number>();
	for (const c of CURRENCIES) {
		counts.set(c.symbol, (counts.get(c.symbol) ?? 0) + 1);
	}
	const unique = new Map<string, boolean>();
	for (const [sym, n] of counts) {
		unique.set(sym, n === 1);
	}
	return unique;
})();

/** One beneficiary in a {@link distribute} call. */
export interface DistributeShare {
	/**
	 * The member this share belongs to. Used ONLY as the tie-break key: when two
	 * beneficiaries have an equal largest remainder, the leftover minor unit goes
	 * to the lower `memberId` (ascending), per PLAN §7.2. Compared as a string for
	 * stable ordering whether ids are numeric or UUID-like.
	 */
	readonly memberId: string | number;
	/**
	 * This beneficiary's weight. Integer or decimal, non-negative. For an `equal`
	 * split every weight is 1; for a `share` split it is the entered share weight;
	 * for charge/FX allocation it is the member's subtotal share.
	 */
	readonly weight: number;
}

/** One resolved share returned by {@link distribute}. */
export interface DistributeResult {
	/** Echoes the input `memberId`. */
	readonly memberId: string | number;
	/** This member's resolved amount in minor units; all results sum to `total`. */
	readonly amount: number;
}

/**
 * Largest-remainder distribution — the shared primitive behind every split,
 * charge/discount allocation, and FX share distribution (PLAN §7.2 / §7.2.3 /
 * §7.6).
 *
 * Splits an integer `total` (minor units) across `shares` in proportion to their
 * weights, returning integer minor-unit amounts **guaranteed to sum exactly to
 * `total`**. Each member first gets the floor of its exact proportional share;
 * the leftover minor units (always fewer than the number of beneficiaries) are
 * handed out one at a time to the largest fractional remainders. **Tie-break:**
 * equal remainders favour the **lower `memberId`** (ascending), so the result is
 * fully deterministic and reproducible.
 *
 * `total` may be negative (a discount allocates a negative effect): the same
 * algorithm runs on the magnitude and the sign is reapplied, so a negative total
 * still sums exactly and uses the identical ascending tie-break.
 *
 * @throws if `shares` is empty, any weight is negative/non-finite, or the total
 *   weight is 0 while `total ≠ 0` (cannot distribute a non-zero amount with no
 *   weight).
 */
export function distribute(total: number, shares: readonly DistributeShare[]): DistributeResult[] {
	if (!Number.isSafeInteger(total)) {
		throw new Error(`Total must be a safe integer minor amount: ${total}`);
	}
	if (shares.length === 0) {
		throw new Error('Cannot distribute across zero beneficiaries');
	}
	for (const s of shares) {
		if (!Number.isFinite(s.weight) || s.weight < 0) {
			throw new Error(`Weight must be a non-negative finite number: ${s.weight}`);
		}
	}

	const totalWeight = shares.reduce((sum, s) => sum + s.weight, 0);
	if (totalWeight === 0) {
		if (total !== 0) {
			throw new Error('Cannot distribute a non-zero total across zero total weight');
		}
		// 0 across 0 weight → everyone gets 0.
		return shares.map((s) => ({ memberId: s.memberId, amount: 0 }));
	}

	const sign = total < 0 ? -1 : 1;
	const absTotal = Math.abs(total);

	// Exact proportional share = absTotal * weight / totalWeight. We compute the
	// floor and keep the fractional remainder as an integer pair (numerator over
	// totalWeight) so remainder comparison stays exact — no float remainders.
	const rows = shares.map((s, index) => {
		const exact = absTotal * s.weight; // numerator; denominator is totalWeight
		const base = Math.floor(exact / totalWeight);
		const remainder = exact - base * totalWeight; // integer in [0, totalWeight)
		return { index, memberId: s.memberId, base, remainder };
	});

	const distributed = rows.reduce((sum, r) => sum + r.base, 0);
	let leftover = absTotal - distributed; // number of extra minor units to hand out

	// Order the leftover recipients: largest remainder first; ties broken by the
	// LOWER memberId (ascending), matching PLAN §7.2 exactly. Compare memberIds as
	// numbers when both look numeric, else lexicographically — deterministic either
	// way. `index` is a final stable fallback (only reachable for duplicate ids).
	const order = [...rows].sort((a, b) => {
		if (b.remainder !== a.remainder) {
			return b.remainder - a.remainder;
		}
		const cmp = compareMemberIds(a.memberId, b.memberId);
		if (cmp !== 0) {
			return cmp;
		}
		return a.index - b.index;
	});

	const extra = new Array<number>(rows.length).fill(0);
	for (let i = 0; i < order.length && leftover > 0; i++) {
		extra[order[i].index] = 1;
		leftover--;
	}

	return rows.map((r) => ({
		memberId: r.memberId,
		amount: sign * (r.base + extra[r.index])
	}));
}

/**
 * Convenience: split `total` minor units **equally** across the given member ids
 * using {@link distribute} (every weight 1). The remainder is distributed by the
 * same largest-remainder + ascending-`memberId` rule, so an amount that doesn't
 * divide evenly is still split deterministically and sums exactly to `total`.
 *
 * @example distributeEqually(100, [1, 2, 3]) // → 34/33/33 (extra unit to id 1)
 */
export function distributeEqually(
	total: number,
	memberIds: readonly (string | number)[]
): DistributeResult[] {
	return distribute(
		total,
		memberIds.map((memberId) => ({ memberId, weight: 1 }))
	);
}

/**
 * Order two member ids ascending: numerically when both are numeric, otherwise
 * by string comparison. Shared by the distribution tie-break so "lower memberId"
 * is well-defined for numeric ids (1 < 2 < 10) and stable for any id shape.
 */
function compareMemberIds(a: string | number, b: string | number): number {
	const an = typeof a === 'number' ? a : Number(a);
	const bn = typeof b === 'number' ? b : Number(b);
	if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) {
		return an - bn;
	}
	const as = String(a);
	const bs = String(b);
	return as < bs ? -1 : as > bs ? 1 : 0;
}
