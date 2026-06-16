// Shared currency-code Zod schema (CLAUDE.md: "shared Zod schemas in lib/schemas/").
//
// `currencyCodeSchema` is the single validation gate for "is this one of the 29
// supported currencies?" (PLAN §7.5.1 / #19). It is DERIVED from the canonical
// `CURRENCY_CODES` constant in `src/lib/money/currencies.ts`, so the accepted set
// can never drift from the data / the seeded DB table. Reused by group
// create/edit (task 3.3, `settlement_currency`) and transaction entry (task 4.x,
// the entry `currency`).
//
// Both the group settlement currency AND a transaction's entry currency must be
// one of these (PLAN §7.5.1). BTC is intentionally excluded (non-fiat, non-ISO
// minor units), so e.g. `'BTC'` is rejected. Matching is case-sensitive against
// the uppercase ISO codes — `'usd'` is rejected (callers normalize to uppercase
// before validating), as are unknown codes (`'XXX'`) and the empty string.

import { z } from 'zod';
import { CURRENCY_CODES } from '../money/currencies';

// `z.enum` needs a non-empty tuple type. `CURRENCY_CODES` is derived from the
// constant (always 29 entries), so this assertion is safe and keeps the enum in
// lockstep with the data — no hand-typed code list to maintain.
const currencyCodeTuple = CURRENCY_CODES as unknown as [string, ...string[]];

/**
 * Accepts exactly the 29 supported uppercase ISO 4217 codes (PLAN §7.5.1);
 * rejects anything else with a single shared message. The parsed value is the
 * matched `CurrencyCode` literal union.
 */
export const currencyCodeSchema = z.enum(currencyCodeTuple, {
	message: 'Select a supported currency'
});

/** Inferred supported-currency code — shared by group + transaction forms/actions. */
export type CurrencyCodeInput = z.infer<typeof currencyCodeSchema>;
