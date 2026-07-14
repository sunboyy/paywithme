// The agent-facing CURRENCY view (ADR-0006, ADR-0004).
//
// REST's `/api/v1/currencies` serves `{ code, exponent, symbol }` — the reference
// table a developer needs to turn minor units into a display string. An agent needs
// the OPPOSITE thing: it must be told that it will NEVER do that arithmetic. Amounts
// on this surface are decimal strings (ADR-0004); `exponent` is here only so the
// model can see how many decimal places a currency ACCEPTS (`"240.005"` in THB is a
// hard error, not a silent round), not so it can multiply by 100.
//
// `name` is carried (REST drops it as a UI label) because a model matching "yen"
// against a code benefits from it, and `example` shows the decimal-string form for
// the one thing that varies: a 0-decimal currency (JPY) vs a 2-decimal one (THB).
//
// This text is app-defined — no member wrote it — so nothing here is wrapped.

import { CURRENCIES } from '$lib/money';

/** One supported currency, as an agent sees it. */
export interface CurrencyView {
	readonly code: string;
	readonly name: string;
	readonly symbol: string;
	/** Decimal places this currency ACCEPTS: 2 for THB/USD, 0 for JPY/KRW/VND. */
	readonly decimalPlaces: number;
	/** A well-formed amount for this currency, e.g. `"240.00"` (THB) / `"240"` (JPY). */
	readonly example: string;
}

/** The steering that keeps exponent arithmetic out of the model's head (ADR-0004). */
export const CURRENCIES_NOTE =
	'paywithme takes and returns every amount as a DECIMAL STRING in the ordinary units ' +
	'a person would say — "240.00" is two hundred and forty. NEVER multiply by 100 or by ' +
	'any power of ten, and never convert between currencies yourself: pass on what the ' +
	'user said, and paywithme does the exponent and FX math server-side. An amount with ' +
	'more decimal places than the currency allows is rejected, not rounded.';

/** The full supported-currency table (PLAN §7.5.1), in the agent's shape. PURE. */
export function toCurrencyViews(): CurrencyView[] {
	return CURRENCIES.map((c) => ({
		code: c.code,
		name: c.name,
		symbol: c.symbol,
		decimalPlaces: c.exponent,
		example: c.exponent === 0 ? '240' : `240.${'0'.repeat(c.exponent)}`
	}));
}
