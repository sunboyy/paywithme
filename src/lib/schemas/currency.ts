// Shared currency-code Zod schemas (CLAUDE.md: "shared Zod schemas in lib/schemas/").
//
// ── TWO ROLES, TWO SCHEMAS (PLAN §7.5.2 / ADR-0014) ───────────────────────────
// A currency code is validated in two different places with two different rules,
// and this module is deliberately split along that line:
//
//   1. `currencyCodeSchema` — the group's **settlement currency**
//      (`groups.settlement_currency`). Still exactly the 29 seeded §7.5.1 codes, a
//      static module-level `z.enum` shared by client and server. A custom currency
//      may NEVER be a settlement currency (ADR-0014 decision 1), so this schema is
//      UNCHANGED and keeps guarding that column on its own.
//
//   2. `buildEntryCurrencySchema(allowed)` — a transaction's **entry currency**.
//      That set is GROUP-SCOPED (the seeded 29 plus this group's own custom rows,
//      exactly what `listCurrenciesForGroup` returns), which is runtime data, not
//      compile-time knowledge — so it cannot be a module-level enum and is
//      produced by a FACTORY closing over the group's allowed set instead
//      (ADR-0014 "Entry-currency validation becomes a schema factory"). The same
//      factory runs on the server (set loaded from the DB) and the client (set
//      passed into the page), so the rule and its message never drift.
//
// Both reject with the SAME shared message, so an unknown code, a wrong-case code
// and ANOTHER GROUP's custom code are one indistinguishable outcome to the user.
//
// `currencyCodeSchema` is DERIVED from the canonical `CURRENCY_CODES` constant in
// `src/lib/money/currencies.ts`, so the accepted set can never drift from the data
// / the seeded DB table. BTC is intentionally excluded (non-fiat, non-ISO minor
// units), so e.g. `'BTC'` is rejected. Matching is case-sensitive against the
// uppercase ISO codes — `'usd'` is rejected (callers normalize to uppercase before
// validating), as are unknown codes (`'XXX'`) and the empty string.

import { z } from 'zod';
import { CURRENCY_CODES } from '../money/currencies';

/**
 * The one message BOTH currency gates reject with. Shared so the settlement gate
 * and the group-scoped entry gate can never drift apart, and so "unknown code",
 * "wrong case" and "another group's custom code" stay indistinguishable (the same
 * don't-leak discipline §12 applies to group existence).
 */
export const UNSUPPORTED_CURRENCY_MESSAGE = 'Select a supported currency';

// `z.enum` needs a non-empty tuple type. `CURRENCY_CODES` is derived from the
// constant (always 29 entries), so this assertion is safe and keeps the enum in
// lockstep with the data — no hand-typed code list to maintain.
const currencyCodeTuple = CURRENCY_CODES as unknown as [string, ...string[]];

/**
 * Accepts exactly the 29 supported uppercase ISO 4217 codes (PLAN §7.5.1);
 * rejects anything else with a single shared message. The parsed value is the
 * matched `SeededCurrencyCode` literal union.
 *
 * This is the **settlement-currency** gate (`groups.settlement_currency`) and is
 * deliberately NOT used for a transaction's entry currency any more — see
 * {@link buildEntryCurrencySchema}.
 */
export const currencyCodeSchema = z.enum(currencyCodeTuple, {
	message: UNSUPPORTED_CURRENCY_MESSAGE
});

/** Inferred supported-currency code — shared by group + transaction forms/actions. */
export type CurrencyCodeInput = z.infer<typeof currencyCodeSchema>;

/**
 * The minimum a caller must hand {@link buildEntryCurrencySchema} to describe one
 * allowed entry currency: its PRIMARY KEY code. A `currencies` row, a
 * `CurrencyDescriptor` and a `GroupCurrency` are all structurally assignable, so
 * callers pass whatever they already loaded rather than mapping first.
 *
 * Note this is the OPAQUE `code`, never `display_code` — the picker submits the
 * primary key (that is what `transactions.currency` stores), and two groups may
 * legitimately both display `BEER`.
 */
export interface EntryCurrencyOption {
	readonly code: string;
}

/**
 * Build the **entry-currency** gate for ONE group (PLAN §7.5.2 / ADR-0014).
 *
 * `allowed` is that group's whole permitted set — the 29 seeded currencies plus
 * the group's own custom rows, i.e. exactly `listCurrenciesForGroup`'s result. One
 * source for the picker and for this validator means the two can never disagree
 * about what may be recorded.
 *
 * Rejects, with {@link UNSUPPORTED_CURRENCY_MESSAGE}:
 *   - a code that exists nowhere (`'XXX'`, `'usd'`, `''`);
 *   - a code belonging to ANOTHER group's custom currency — it is simply absent
 *     from this group's set, so it fails the same way an unknown code does and
 *     nothing leaks about whether it exists elsewhere.
 *
 * Membership is checked against the code SET rather than a `z.enum` because the
 * custom half is runtime data; the parsed value is the matched code string.
 */
export function buildEntryCurrencySchema(allowed: readonly EntryCurrencyOption[]) {
	const codes = new Set(allowed.map((c) => c.code));
	return z
		.string({ message: UNSUPPORTED_CURRENCY_MESSAGE })
		.refine((code) => codes.has(code), { message: UNSUPPORTED_CURRENCY_MESSAGE });
}
