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
//                by ascending `member_id` ROTATED by the caller's rotation offset
//                (ADR-0013), so shares sum EXACTLY to the total AND the member who
//                absorbs the leftover unit changes from transaction to transaction.
//
// All per-currency precision is read from the currency's `exponent` — resolved
// from `currencies.ts` (the single source of truth for the SEEDED 29) when the
// caller passes a code, or taken straight off a `CurrencyDescriptor` when it
// passes a resolved row. NEVER hardcoded "×100" / "2 dp".
//
// That descriptor overload is what lets a GROUP-DEFINED custom currency (PLAN
// §7.5.2 / ADR-0014) parse and format here: it exists only as a `currencies` row,
// so the synchronous `getCurrency()` lookup over the compiled-in constant cannot
// find it. No arithmetic changes for it — the core below was always exponent-
// driven; this is purely an adapter above it.
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

import {
	CURRENCIES,
	getCurrency,
	isCustomCurrency,
	type CurrencyDescriptor,
	type EntryCurrencyCode,
	type SeededCurrencyCode
} from './currencies';

/**
 * The largest minor-unit magnitude we accept. Equal to `Number.MAX_SAFE_INTEGER`
 * — beyond this, integer `number` math is no longer exact, so we reject at the
 * parse boundary rather than risk a silently-wrong amount.
 */
export const MAX_SAFE_MINOR = Number.MAX_SAFE_INTEGER;

/**
 * What every public money helper accepts to say "which currency": either a
 * **code** (resolved here against the seeded {@link CURRENCIES} constant) or an
 * already-**resolved** {@link CurrencyDescriptor}.
 *
 * The descriptor form is the one that works for a group-defined custom currency
 * (PLAN §7.5.2 / ADR-0014 decision 4): its code exists only as a `currencies`
 * row, so `getCurrency()` — a synchronous lookup over a compiled-in constant —
 * cannot find it and throws. Callers that have loaded the row pass the row.
 *
 * The code form is unchanged for the seeded 29 and stays the ergonomic default
 * everywhere the currency IS one of them.
 */
export type CurrencyRef = EntryCurrencyCode | CurrencyDescriptor;

/**
 * Normalise a {@link CurrencyRef} to a descriptor.
 *
 * A code is looked up in the seeded constant and widened to a descriptor whose
 * `displayCode` equals its `code` — which is precisely the seeded-row invariant
 * (`code == display_code`), so a seeded currency behaves identically whether it
 * arrives as a code or as a row.
 *
 * @throws if the code is not a seeded currency, or the descriptor is malformed.
 */
function resolveCurrency(currency: CurrencyRef): CurrencyDescriptor {
	if (typeof currency !== 'string') {
		return assertDescriptor(currency);
	}
	const seeded = getCurrency(currency);
	if (seeded === undefined) {
		// Includes the "custom currency passed as a bare code" case: the caller must
		// resolve the row and pass the descriptor. Failing loudly here is deliberate —
		// the alternative is formatting an amount at the wrong precision.
		throw new Error(`Unknown currency code: ${String(currency)}`);
	}
	return {
		code: seeded.code,
		displayCode: seeded.code,
		exponent: seeded.exponent,
		symbol: seeded.symbol
	};
}

/**
 * Guard a caller-supplied descriptor. It carries the exponent that decides how
 * every amount against it is interpreted, so a malformed one is a data bug worth
 * failing on rather than rendering nonsense at "exponent NaN".
 */
function assertDescriptor(currency: CurrencyDescriptor): CurrencyDescriptor {
	const { code, displayCode, exponent } = currency;
	if (typeof code !== 'string' || code.trim() === '') {
		throw new Error('Currency descriptor has an empty code');
	}
	if (typeof displayCode !== 'string' || displayCode.trim() === '') {
		// Without a display code there is nothing safe to prefix — the opaque `code`
		// must never reach a screen (CONTEXT.md "Display code").
		throw new Error(`Currency descriptor has an empty display code: ${code}`);
	}
	if (!Number.isSafeInteger(exponent) || exponent < 0) {
		throw new Error(
			`Currency descriptor has an invalid exponent: ${displayCode} has ${String(exponent)}`
		);
	}
	return currency;
}

/**
 * Public form of {@link resolveCurrency}: normalise a {@link CurrencyRef} to a
 * validated {@link CurrencyDescriptor}.
 *
 * For callers that need the resolved row itself rather than a formatted string —
 * chiefly the §7.6 conversion, which needs the entry currency's `exponent` and
 * must work for a group-defined custom currency whose code `getCurrency()` cannot
 * find. Passing a descriptor through returns it (after the same shape guard a
 * formatter would apply); passing a seeded code widens it with
 * `displayCode === code`, the seeded-row invariant.
 *
 * @throws if the code is not a seeded currency, or the descriptor is malformed.
 */
export function toCurrencyDescriptor(currency: CurrencyRef): CurrencyDescriptor {
	return resolveCurrency(currency);
}

/**
 * `10 ** exponent` for `currency` — the factor between one major unit and its
 * minor units (1 for 0-dp currencies, 100 for 2-dp, 1000 for 3-dp). Reads the
 * resolved exponent so precision is always per-currency.
 *
 * @throws if a code is passed that is not a seeded currency.
 */
export function scaleFactor(currency: CurrencyDescriptor): number;
export function scaleFactor(code: EntryCurrencyCode): number;
export function scaleFactor(currency: CurrencyRef): number {
	return 10 ** resolveCurrency(currency).exponent;
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
 * `currency`, using that currency's own exponent (no hardcoded dp).
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
 * Takes either a seeded code or a resolved {@link CurrencyDescriptor}, so a
 * group-defined custom currency parses through the identical path at its own
 * exponent (PLAN §7.5.2).
 *
 * @example parseAmount('12.50', 'USD') // → 1250
 * @example parseAmount('1,000', 'JPY') // → 1000
 * @example parseAmount('1.234', beerDescriptor) // → 1234 (3-dp custom currency)
 */
export function parseAmount(
	input: string,
	currency: CurrencyDescriptor,
	opts?: ParseAmountOptions
): number;
export function parseAmount(
	input: string,
	code: EntryCurrencyCode,
	opts?: ParseAmountOptions
): number;
export function parseAmount(
	input: string,
	currency: CurrencyRef,
	opts?: ParseAmountOptions
): number {
	const { exponent, displayCode } = resolveCurrency(currency);
	// The error label is the DISPLAY code — an opaque custom `code` must never
	// surface in a message a user reads.
	return parseMinor(input, exponent, { ...opts, code: displayCode });
}

/**
 * Constrain a **partially typed** major-unit string to something `parseAmount`
 * can accept for `currency` — the entry-side counterpart to {@link parseAmount}.
 *
 * `parseAmount` is all-or-nothing: it throws on junk, which is right for a value
 * being committed but useless for a field being typed into, where the input is
 * legitimately incomplete between keystrokes. This keeps only what can still
 * become a valid amount:
 *
 *   - non-numeric characters are dropped (`"12a"` → `"12"`, `"$5"` → `"5"`), so a
 *     rejected keystroke simply never appears rather than sitting in the box
 *     making the field disagree with the value it parses to;
 *   - thousands separators are dropped (`"1,234"` → `"1234"`) — same amount;
 *   - only the FIRST decimal point survives (`"1.2.3"` → `"1.23"`);
 *   - fractional digits are capped at the currency's exponent, so the extra digit
 *     is refused AS IT IS TYPED (`"1.234"` → `"1.23"` for THB) — that is a refused
 *     keystroke the user sees immediately, not a complete value silently rounded,
 *     which {@link parseAmount} still rejects outright;
 *   - a 0-dp currency keeps no fraction at all (`"5.5"` → `"5"` for JPY);
 *   - a leading point gains its `0` (`".5"` → `"0.5"`), which parses;
 *   - a TRAILING point is preserved (`"12."`), because it is the normal midpoint
 *     of typing "12.50" — it parses to nothing, so the caller treats it as 0 until
 *     a digit follows.
 *
 * Signs are dropped: every field this backs is non-negative entry.
 *
 * Takes either a seeded code or a resolved {@link CurrencyDescriptor} (PLAN
 * §7.5.2), so an amount field denominated in a custom currency caps its decimals
 * at that currency's own exponent.
 *
 * @example sanitizeAmountInput('12.345', 'THB') // → '12.34'
 * @example sanitizeAmountInput('12.5', 'JPY')   // → '12'
 */
export function sanitizeAmountInput(input: string, currency: CurrencyDescriptor): string;
export function sanitizeAmountInput(input: string, code: EntryCurrencyCode): string;
export function sanitizeAmountInput(input: string, currency: CurrencyRef): string {
	const { exponent } = resolveCurrency(currency);
	const cleaned = input.replace(/[^\d.]/g, '');
	const dot = cleaned.indexOf('.');
	if (dot === -1) return cleaned;

	const intDigits = cleaned.slice(0, dot);
	if (exponent === 0) return intDigits;
	const fracDigits = cleaned.slice(dot + 1).replace(/\./g, '');
	return `${intDigits === '' ? '0' : intDigits}.${fracDigits.slice(0, exponent)}`;
}

/** Options for {@link parseMinor} — {@link ParseAmountOptions} plus a label for errors. */
interface ParseMinorOptions extends ParseAmountOptions {
	/** A label (the currency's DISPLAY code) for the "too many decimal places" message. */
	readonly code?: string;
}

/**
 * Exponent-driven core of {@link parseAmount}, package-private so the public
 * function (which resolves the exponent from a {@link CurrencyRef}) and the unit
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
	/**
	 * Prefix the currency's DISPLAY code when the symbol is ambiguous on its own
	 * (default `true` — the globally-safe disambiguation documented on
	 * {@link formatAmount}).
	 *
	 * Set `false` on surfaces where the currency is already established by
	 * context and repeating it is noise — inside a single group, every amount is
	 * in that group's settlement currency, which the page header already states,
	 * so `JPY ¥3,200` on every row is redundant and steals width from the
	 * content beside it. With `code: false` the bare symbol is used and the sign
	 * moves OUTSIDE it (`-¥21,560`, not `¥-21,560`).
	 *
	 * Leave it at the default wherever two currencies can appear together (the
	 * groups list, the foreign-currency secondary line) or on machine-readable
	 * surfaces (MCP / API views), where self-identifying amounts are the point.
	 *
	 * **Ignored for a group-defined custom currency**, which always disambiguates
	 * (PLAN §7.5.2). The opt-out exists because "inside one group, every amount is
	 * in the settlement currency" — an assumption a custom currency contradicts by
	 * construction: it is entry-only and therefore ALWAYS foreign (ADR-0014
	 * decision 6), so it only ever renders beside settlement amounts. Honouring
	 * `false` there would let a member-authored `$` sit next to a real USD `$`.
	 */
	readonly code?: boolean;
}

/**
 * Format integer **minor units** into a display string at the currency's own
 * decimal precision, with a disambiguated symbol.
 *
 * Takes either a seeded code or a resolved {@link CurrencyDescriptor} — the
 * descriptor form is how a group-defined custom currency is formatted, since its
 * code is not in the compiled-in constant (PLAN §7.5.2).
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
 *     `₩`, …) — we PREFIX the DISPLAY code: `SEK kr`, `NOK kr`, `USD $`.
 *   - A **custom** currency skips the test and is ALWAYS code-prefixed. The
 *     "unique" half of the test is answered by `SYMBOL_IS_UNIQUE`, a map computed
 *     over the CLOSED seeded set; a member-authored symbol was never in that set,
 *     so it can be assumed neither unique nor free of `$` (PLAN §7.5.2 / ADR-0014
 *     decision 4). `BEER kr3.00`, never a bare `kr3.00` that reads as NOK.
 *
 * The prefixed code is always the **display** code (`THB`, `BEER`) — the opaque
 * `code` of a custom row is never emitted (CONTEXT.md "Display code").
 *
 * In practice the seeded data pre-disambiguates most collisions (CNY=`CN¥`, HK$,
 * NT$, CA$, MX$, S$), leaving SEK/NOK (`kr`) which this rule splits into
 * `SEK kr` / `NOK kr`. The bare-glyph branch additionally code-prefixes pure
 * symbols like `¥` (JPY) so JPY can never collide with a future bare-`¥` row, and
 * makes every formatted amount self-identifying.
 *
 * @example formatAmount(1250, 'USD') // → 'USD $12.50'  (bare '$' → code-prefixed)
 * @example formatAmount(1000, 'JPY') // → 'JPY ¥1,000'  (0 dp, bare glyph)
 * @example formatAmount(50000, 'SEK') // → 'SEK kr500.00'
 * @example formatAmount(50000, 'NOK') // → 'NOK kr500.00' (distinct from SEK)
 *
 * Pass `{ code: false }` where the currency is already established by context
 * (inside one group) — see {@link FormatAmountOptions.code}:
 *
 * @example formatAmount(1000, 'JPY', { code: false })   // → '¥1,000'
 * @example formatAmount(-2156000, 'JPY', { code: false }) // → '-¥2,156,000'
 */
export function formatAmount(
	minor: number,
	currency: CurrencyDescriptor,
	opts?: FormatAmountOptions
): string;
export function formatAmount(
	minor: number,
	code: EntryCurrencyCode,
	opts?: FormatAmountOptions
): string;
export function formatAmount(
	minor: number,
	currency: CurrencyRef,
	opts?: FormatAmountOptions
): string {
	if (!Number.isSafeInteger(minor)) {
		throw new Error(`Minor amount must be a safe integer: ${minor}`);
	}
	const resolved = resolveCurrency(currency);
	const { exponent, symbol } = resolved;
	const custom = isCustomCurrency(resolved);
	const withSymbol = opts?.symbol ?? true;
	const grouped = opts?.grouped ?? true;
	// A custom currency always disambiguates, so `code: false` cannot suppress the
	// prefix there — see {@link FormatAmountOptions.code}.
	const withCode = custom || (opts?.code ?? true);

	const numeric = formatMinor(minor, exponent, grouped);

	if (!withSymbol) {
		return numeric;
	}
	if (!withCode) {
		// Context-established currency: bare symbol, sign hoisted in front of it so
		// a negative reads `-¥21,560` rather than `¥-21,560`.
		const negative = numeric.startsWith('-');
		return `${negative ? '-' : ''}${symbol}${negative ? numeric.slice(1) : numeric}`;
	}
	return `${composeSymbolPrefix(resolved.displayCode, symbol, custom)}${numeric}`;
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
 * Compose the display prefix for a currency, applying the disambiguation rule
 * documented on {@link formatAmount}. Exported for tests and any UI that needs
 * the prefix on its own.
 *
 * A symbol is used bare only when it (a) begins with an ASCII letter — i.e. it is
 * already a code-like token such as `CN¥`, `HK$`, `CHF`, `kr` — AND (b) is unique
 * across the seeded currencies. Bare glyphs and colliding symbols get
 * `"<DISPLAY CODE> "` prefixed, and a **custom** currency always does (its symbol
 * is member-authored, so neither test can vouch for it).
 *
 * The two-argument form is deliberately restricted to a {@link SeededCurrencyCode}
 * — for a custom currency the code you have is the opaque one, which must never
 * be displayed, so pass the descriptor instead.
 */
export function symbolPrefix(currency: CurrencyDescriptor): string;
export function symbolPrefix(code: SeededCurrencyCode, symbol: string): string;
export function symbolPrefix(
	currency: SeededCurrencyCode | CurrencyDescriptor,
	symbol?: string
): string {
	if (typeof currency !== 'string') {
		const resolved = assertDescriptor(currency);
		return composeSymbolPrefix(resolved.displayCode, resolved.symbol, isCustomCurrency(resolved));
	}
	return composeSymbolPrefix(currency, symbol ?? '', false);
}

/**
 * The shared prefix rule. `alwaysDisambiguate` is set for a custom currency,
 * whose symbol cannot be checked against {@link SYMBOL_IS_UNIQUE} because that
 * map is computed over the closed seeded set (PLAN §7.5.2).
 */
function composeSymbolPrefix(
	displayCode: string,
	symbol: string,
	alwaysDisambiguate: boolean
): string {
	const startsWithLetter = /^[A-Za-z]/.test(symbol);
	const unique = SYMBOL_IS_UNIQUE.get(symbol) ?? false;
	if (!alwaysDisambiguate && startsWithLetter && unique) {
		return symbol;
	}
	return `${displayCode} ${symbol}`;
}

/**
 * Map of stored symbol → whether exactly one currency uses it. Built once so the
 * disambiguation rule can detect collisions (SEK/NOK `kr`) at O(1).
 *
 * Computed over the SEEDED set only, which is why a custom currency's symbol can
 * never be looked up here and is always disambiguated instead.
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
	 * to the lower `memberId` (ascending) — ROTATED by the caller's `rotation`
	 * offset (PLAN §7.2 / ADR-0013). Compared as a string for stable ordering
	 * whether ids are numeric or UUID-like.
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
 * handed out one at a time to the largest fractional remainders.
 *
 * **Tie-break (ADR-0013):** equal remainders are broken by ascending `memberId`
 * ROTATED by `rotation`. At `rotation = 0` (the default) this is exactly "lowest
 * `memberId` wins"; each increment advances the starting point by one member, so
 * consecutive transactions hand the leftover unit to a different beneficiary in
 * turn. Callers pass the transaction's stored `rounding_seq` (+ the split line's
 * ordinal), which is why an equal split of ฿100 three ways gives the extra satang
 * to a different member on each of three transactions instead of always the same
 * one. Rotation only ever reorders TIED remainders — a larger remainder still
 * wins outright, so `share`/FX/charge distributions are unaffected wherever the
 * proportions genuinely differ.
 *
 * `total` may be negative (a discount allocates a negative effect): the same
 * algorithm runs on the magnitude and the sign is reapplied, so a negative total
 * still sums exactly and uses the identical rotated tie-break.
 *
 * @param rotation  tie-break offset; any integer (negative and ≥ n both wrap).
 *   Defaults to 0 — the pre-ADR-0013 "lowest `memberId`" behaviour.
 * @throws if `shares` is empty, any weight is negative/non-finite, `rotation` is
 *   not a safe integer, or the total weight is 0 while `total ≠ 0` (cannot
 *   distribute a non-zero amount with no weight).
 */
export function distribute(
	total: number,
	shares: readonly DistributeShare[],
	rotation = 0
): DistributeResult[] {
	if (!Number.isSafeInteger(total)) {
		throw new Error(`Total must be a safe integer minor amount: ${total}`);
	}
	if (shares.length === 0) {
		throw new Error('Cannot distribute across zero beneficiaries');
	}
	if (!Number.isSafeInteger(rotation)) {
		throw new Error(`Rotation must be a safe integer: ${rotation}`);
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

	// Each row's ROTATED rank: its position in the ascending-memberId ordering,
	// shifted back by `rotation` (ADR-0013). At rotation 0 rank order IS memberId
	// order, so this reduces exactly to the original "lowest memberId wins".
	const rank = rotatedRanks(rows, rotation);

	// Order the leftover recipients: largest remainder first; ties broken by the
	// lowest ROTATED rank, per PLAN §7.2 + ADR-0013. `index` is a final stable
	// fallback (unreachable while ranks are unique — kept so the comparator stays
	// total regardless).
	const order = [...rows].sort((a, b) => {
		if (b.remainder !== a.remainder) {
			return b.remainder - a.remainder;
		}
		const rankCmp = rank[a.index] - rank[b.index];
		if (rankCmp !== 0) {
			return rankCmp;
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
 * Rotated tie-break ranks, by row `index` (ADR-0013).
 *
 * Rows are ordered ascending by `memberId` (the pre-ADR-0013 tie-break order),
 * giving each a position 0…n-1; that position is then shifted back by
 * `rotation mod n`. So rotation 0 leaves the lowest `memberId` at rank 0,
 * rotation 1 promotes the SECOND-lowest to rank 0, and so on, wrapping. Ranks
 * are a permutation of 0…n-1 — unique by construction, so they settle the
 * tie-break on their own.
 *
 * Negative rotations wrap the same way (`((r % n) + n) % n`), so a caller need
 * not normalise before passing one.
 */
function rotatedRanks(
	rows: readonly { readonly index: number; readonly memberId: string | number }[],
	rotation: number
): number[] {
	const n = rows.length;
	const byMemberId = [...rows].sort((a, b) => {
		const cmp = compareMemberIds(a.memberId, b.memberId);
		return cmp !== 0 ? cmp : a.index - b.index;
	});
	const shift = ((rotation % n) + n) % n;
	const rank = new Array<number>(n).fill(0);
	byMemberId.forEach((row, position) => {
		rank[row.index] = (position - shift + n) % n;
	});
	return rank;
}

/**
 * Convenience: split `total` minor units **equally** across the given member ids
 * using {@link distribute} (every weight 1). The remainder is distributed by the
 * same largest-remainder + rotated-`memberId` rule, so an amount that doesn't
 * divide evenly is still split deterministically and sums exactly to `total`.
 *
 * An equal split makes EVERY remainder tie, so `rotation` decides the whole
 * leftover assignment here — this is the call where ADR-0013's rotation is most
 * visible.
 *
 * @example distributeEqually(100, [1, 2, 3]) // → 34/33/33 (extra unit to id 1)
 * @example distributeEqually(100, [1, 2, 3], 1) // → 33/34/33 (extra unit to id 2)
 */
export function distributeEqually(
	total: number,
	memberIds: readonly (string | number)[],
	rotation = 0
): DistributeResult[] {
	return distribute(
		total,
		memberIds.map((memberId) => ({ memberId, weight: 1 })),
		rotation
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
