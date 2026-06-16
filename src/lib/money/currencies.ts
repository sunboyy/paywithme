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
 * field a literal so `CurrencyCode` can be derived from it with no hand-typed
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
 * Union of every supported ISO code, e.g. `'USD' | 'THB' | …`. Derived from
 * `CURRENCIES` so adding a row automatically widens the type — used by the Zod
 * enum and any code that wants a compile-time-checked currency code.
 */
export type CurrencyCode = (typeof CURRENCIES)[number]['code'];

/**
 * All 29 codes as a readonly tuple, in PLAN order. Derived from `CURRENCIES`;
 * `lib/schemas/currency.ts` builds its `z.enum` from this so the validation set
 * can never drift from the data.
 */
export const CURRENCY_CODES = CURRENCIES.map((c) => c.code) as readonly CurrencyCode[];

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
