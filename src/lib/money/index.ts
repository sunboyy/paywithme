// Public surface of `lib/money` — the currency-aware money layer (PLAN §7.5).
//
// Re-exports the canonical currency data (task 3.2) and the parse / format /
// distribute primitives (task 4.1) from one entry point, so downstream
// transaction / split / charge / FX code imports `$lib/money` rather than
// reaching into individual files.
//
// Note the two currency-code types (ADR-0014): `SeededCurrencyCode` is the
// literal union of the 29 §7.5.1 codes and the value space of a group's
// SETTLEMENT currency; `EntryCurrencyCode` is a transaction's ENTRY currency,
// which may also be a group-defined custom code. `CurrencyDescriptor` is the
// resolved row the money helpers take when a code cannot be looked up.

export {
	type Currency,
	type CurrencyDescriptor,
	type EntryCurrencyCode,
	type SeededCurrencyCode,
	CURRENCIES,
	CURRENCY_CODES,
	SEEDED_CURRENCY_DESCRIPTORS,
	asEntryCurrencyCode,
	getCurrency,
	isCustomCurrency
} from './currencies';

export {
	type CurrencyRef,
	type ParseAmountOptions,
	type FormatAmountOptions,
	type DistributeShare,
	type DistributeResult,
	MAX_SAFE_MINOR,
	scaleFactor,
	toCurrencyDescriptor,
	parseAmount,
	sanitizeAmountInput,
	formatAmount,
	symbolPrefix,
	distribute,
	distributeEqually
} from './money';
