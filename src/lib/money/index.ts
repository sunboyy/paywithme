// Public surface of `lib/money` — the currency-aware money layer (PLAN §7.5).
//
// Re-exports the canonical currency data (task 3.2) and the parse / format /
// distribute primitives (task 4.1) from one entry point, so downstream
// transaction / split / charge / FX code imports `$lib/money` rather than
// reaching into individual files.

export {
	type Currency,
	type CurrencyCode,
	CURRENCIES,
	CURRENCY_CODES,
	getCurrency
} from './currencies';

export {
	type ParseAmountOptions,
	type FormatAmountOptions,
	type DistributeShare,
	type DistributeResult,
	MAX_SAFE_MINOR,
	scaleFactor,
	parseAmount,
	formatAmount,
	symbolPrefix,
	distribute,
	distributeEqually
} from './money';
