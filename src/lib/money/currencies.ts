// Canonical currency data — the SINGLE SOURCE OF TRUTH for the app's supported
// fiat currencies (PLAN §7.5.1 / decision #19). This is *data only*: it
// establishes the `lib/money` directory but deliberately contains NO parse /
// format / distribution math (that is task 4.1's currency-aware helper).
//
// Everything downstream derives from `CURRENCIES` so the three representations
// can never drift:
//   - the Drizzle `currencies` table + its seed migration (re-exported via
//     `lib/server/db/schema.ts`) seed exactly these rows;
//   - the shared `currencyCodeSchema` Zod enum (`lib/schemas/currency.ts`) is
//     built from `CURRENCY_CODES`;
//   - money math in 4.1 reads `getCurrency(code).exponent` for O(1) per-currency
//     minor-unit scaling.
//
// ── What this file is NOT (ADR-0014 / PLAN §7.5.2) ──
// It is the source of truth for the **seeded** currencies only. A group may also
// define a **custom** currency, which exists solely as a `currencies` row and can
// never appear here or in `SeededCurrencyCode`. Code that must serve both kinds
// takes a resolved {@link CurrencyDescriptor} instead of a code (that is the whole
// point of the descriptor); `CURRENCY_CODES` / `currencyCodeSchema` keep meaning
// "the seeded 29" and keep guarding `groups.settlement_currency`, which a custom
// currency may never be.
//
// The list is the **top 30 fiat currencies by market cap from fiatmarketcap.net,
// minus BTC** — BTC is excluded because it is non-fiat and its 8-decimal,
// non-ISO-4217 minor units don't fit the integer-exponent model (PLAN §7.5.1).
//
// `exponent` is the ISO 4217 minor-unit count: JPY / KRW / VND = 0, every other
// row = 2. The model still supports ARBITRARY exponents (0–3) so a future
// 3-decimal currency (e.g. KWD/BHD) is addable by adding a row here — no code
// anywhere branches on a literal "2 vs 0", it always reads the stored exponent.

/** One supported fiat currency. `code` is uppercase ISO 4217. */
export interface Currency {
	/** Uppercase ISO 4217 alphabetic code, e.g. `'USD'`. */
	readonly code: string;
	/** Human-readable display name, e.g. `'US Dollar'`. */
	readonly name: string;
	/**
	 * ISO 4217 minor-unit exponent (the power of ten between major and minor
	 * units). `0` for JPY/KRW/VND, `2` for the rest of this set; the money helper
	 * (task 4.1) supports any 0–3 value so 3-decimal currencies stay addable.
	 */
	readonly exponent: number;
	/** Currency symbol for display, e.g. `'$'`, `'฿'`, `'CN¥'`. */
	readonly symbol: string;
}

/**
 * The canonical, ordered list of all 29 supported currencies (PLAN §7.5.1).
 * Order matches the PLAN table (rank by market cap). `as const` makes every
 * field a literal so `SeededCurrencyCode` can be derived from it with no hand-typed
 * duplicate union.
 */
export const CURRENCIES = [
	{ code: 'CNY', name: 'Chinese Yuan', exponent: 2, symbol: 'CN¥' },
	{ code: 'USD', name: 'US Dollar', exponent: 2, symbol: '$' },
	{ code: 'EUR', name: 'Euro', exponent: 2, symbol: '€' },
	{ code: 'JPY', name: 'Japanese Yen', exponent: 0, symbol: '¥' },
	{ code: 'GBP', name: 'Pound Sterling', exponent: 2, symbol: '£' },
	{ code: 'KRW', name: 'South Korean Won', exponent: 0, symbol: '₩' },
	{ code: 'HKD', name: 'Hong Kong Dollar', exponent: 2, symbol: 'HK$' },
	{ code: 'TWD', name: 'New Taiwan Dollar', exponent: 2, symbol: 'NT$' },
	{ code: 'CAD', name: 'Canadian Dollar', exponent: 2, symbol: 'CA$' },
	{ code: 'RUB', name: 'Russian Ruble', exponent: 2, symbol: '₽' },
	{ code: 'BRL', name: 'Brazilian Real', exponent: 2, symbol: 'R$' },
	{ code: 'CHF', name: 'Swiss Franc', exponent: 2, symbol: 'CHF' },
	{ code: 'MXN', name: 'Mexican Peso', exponent: 2, symbol: 'MX$' },
	{ code: 'INR', name: 'Indian Rupee', exponent: 2, symbol: '₹' },
	{ code: 'SAR', name: 'Saudi Riyal', exponent: 2, symbol: 'SAR' },
	{ code: 'AED', name: 'UAE Dirham', exponent: 2, symbol: 'AED' },
	{ code: 'PLN', name: 'Polish Zloty', exponent: 2, symbol: 'zł' },
	{ code: 'THB', name: 'Thai Baht', exponent: 2, symbol: '฿' },
	{ code: 'SGD', name: 'Singapore Dollar', exponent: 2, symbol: 'S$' },
	{ code: 'VND', name: 'Vietnamese Dong', exponent: 0, symbol: '₫' },
	{ code: 'MYR', name: 'Malaysian Ringgit', exponent: 2, symbol: 'RM' },
	{ code: 'TRY', name: 'Turkish Lira', exponent: 2, symbol: '₺' },
	{ code: 'IDR', name: 'Indonesian Rupiah', exponent: 2, symbol: 'Rp' },
	{ code: 'SEK', name: 'Swedish Krona', exponent: 2, symbol: 'kr' },
	{ code: 'ILS', name: 'Israeli New Shekel', exponent: 2, symbol: '₪' },
	{ code: 'NOK', name: 'Norwegian Krone', exponent: 2, symbol: 'kr' },
	{ code: 'CZK', name: 'Czech Koruna', exponent: 2, symbol: 'Kč' },
	{ code: 'PHP', name: 'Philippine Peso', exponent: 2, symbol: '₱' },
	{ code: 'ZAR', name: 'South African Rand', exponent: 2, symbol: 'R' }
] as const satisfies readonly Currency[];

/**
 * Union of every **seeded** ISO code, e.g. `'USD' | 'THB' | …`. Derived from
 * `CURRENCIES` so adding a row automatically widens the type — used by the Zod
 * enum and any code that wants a compile-time-checked currency code.
 *
 * This union is exactly "the 29 §7.5.1 currencies", which is exactly the value
 * space of a group's **settlement currency** (`groups.settlement_currency`) — a
 * custom currency may never be one (ADR-0014 decision 1). It is deliberately NOT
 * the type of a transaction's **entry** currency; that is
 * {@link EntryCurrencyCode}. It was called `CurrencyCode` until ADR-0014 forced
 * the split; the name now says which of the two it is.
 */
export type SeededCurrencyCode = (typeof CURRENCIES)[number]['code'];

declare const ENTRY_CURRENCY_BRAND: unique symbol;

/**
 * A code that may appear as a transaction's **entry** currency (PLAN §7.5.2 /
 * ADR-0014): either one of the seeded 29, or the opaque, generated `code` of a
 * group-defined custom currency row (`cur_…`, see
 * `lib/server/db/currencies-schema.ts`).
 *
 * The custom half cannot be a literal union — those codes are runtime data, not
 * compile-time knowledge — so this is a **branded** string. The brand is what
 * keeps the split honest in both directions:
 *
 *   - a seeded code is assignable to it (every settlement currency is a valid
 *     entry currency), so `entry === settlement` comparisons and "pass the
 *     settlement code where an entry code is wanted" keep working; but
 *   - an arbitrary `string` is NOT, so a bare typo (`formatAmount(1, 'USDD')`)
 *     is still a compile error, exactly as it was before the split. Widening the
 *     type to plain `string` would have silently thrown that check away.
 *
 * Produce one from a raw string with {@link asEntryCurrencyCode} — the single
 * documented chokepoint that replaces the old `as CurrencyCode` casts on
 * entry-currency values (which asserted membership of the 29 and were, for a
 * custom currency, simply false).
 */
export type EntryCurrencyCode =
	SeededCurrencyCode | (string & { readonly [ENTRY_CURRENCY_BRAND]: true });

/**
 * Tag a raw string (a DB `transactions.currency` value, a validated form field,
 * an MCP argument) as an {@link EntryCurrencyCode}.
 *
 * The only runtime check possible here is structural — whether the code names a
 * currency the *group* may use is a DB question, answered by the
 * `transactions.currency → currencies.code` foreign key and (task #63) the
 * group-scoped entry-currency schema. So this rejects the one thing that is
 * always wrong (an empty / blank code) and otherwise records the provenance in
 * the type.
 *
 * @throws if `code` is empty or whitespace-only.
 */
export function asEntryCurrencyCode(code: string): EntryCurrencyCode {
	if (code.trim() === '') {
		throw new Error('Entry currency code is empty');
	}
	return code as EntryCurrencyCode;
}

/**
 * A **resolved currency descriptor** — everything `lib/money` needs to parse and
 * format an amount, with nothing left to look up (PLAN §7.5.2 "Display and
 * formatting"; ADR-0014 decision 4).
 *
 * This is the shape that lets the money helpers serve a currency that is NOT in
 * the compiled-in {@link CURRENCIES} constant: a group-defined custom currency
 * lives only in the `currencies` table, so its caller resolves the row and hands
 * the descriptor over rather than a code the helper would fail to look up. A
 * `currencies` row is structurally assignable to it as-is.
 *
 * `code` is the opaque primary key and is **never displayed**; `displayCode` is
 * the user-visible one (`THB`, `BEER`) and is the only code the formatter emits
 * (CONTEXT.md "Display code").
 */
export interface CurrencyDescriptor {
	/** Primary key. The ISO code for a seeded row, an opaque `cur_…` id for a custom one. Never displayed. */
	readonly code: string;
	/** The user-visible code — `code` for a seeded row, what the member typed for a custom one. */
	readonly displayCode: string;
	/** Minor-unit exponent; drives all per-currency precision (PLAN §7.5). */
	readonly exponent: number;
	/** Display symbol, e.g. `'$'`, `'฿'`, `'CN¥'`. Member-authored on a custom row. */
	readonly symbol: string;
}

/**
 * Is this descriptor a **group-defined custom** currency rather than one of the
 * seeded 29?
 *
 * Read straight off the invariant the schema guarantees: a seeded row has
 * `code == display_code`, and a custom row's `code` is a generated `cur_<uuid>`
 * (lowercase-prefixed, so it can never equal an uppercase ISO-shaped display
 * code — `CUSTOM_CURRENCY_CODE_PREFIX`). No extra field, no DB round-trip.
 *
 * The distinction is load-bearing for display: a custom currency's symbol is
 * member-authored, so it can be assumed neither unique nor free of `$`, and must
 * therefore ALWAYS be disambiguated (PLAN §7.5.2; ADR-0014 decision 4).
 */
export function isCustomCurrency(currency: CurrencyDescriptor): boolean {
	return currency.code !== currency.displayCode;
}

/**
 * All 29 codes as a readonly tuple, in PLAN order. Derived from `CURRENCIES`;
 * `lib/schemas/currency.ts` builds its `z.enum` from this so the validation set
 * can never drift from the data.
 */
export const CURRENCY_CODES = CURRENCIES.map((c) => c.code) as readonly SeededCurrencyCode[];

/**
 * O(1) lookup map (code → Currency). Built once at module load; backs
 * `getCurrency` and lets money math (task 4.1) resolve a currency's exponent
 * without scanning the list.
 */
const CURRENCY_BY_CODE: ReadonlyMap<string, Currency> = new Map(CURRENCIES.map((c) => [c.code, c]));

/**
 * Resolve a currency by its (case-sensitive, uppercase ISO) code.
 *
 * Pure and synchronous. Returns the matching {@link Currency} or `undefined` for
 * an unknown / wrong-case code (e.g. `'usd'`, `'BTC'`, `'XXX'`). Callers that
 * have already validated the code via `currencyCodeSchema` can treat a non-`undefined`
 * result as guaranteed.
 */
export function getCurrency(code: string): Currency | undefined {
	return CURRENCY_BY_CODE.get(code);
}
