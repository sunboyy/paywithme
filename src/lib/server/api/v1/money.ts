// The `/api/v1` money-on-wire shape (PLAN §16.4) + the governing decision for
// this whole DTO layer.
//
// ── The one money rule every v1 DTO obeys ──────────────────────────────────
// Every monetary value on the wire is a self-describing `{ amount, currency }`
// object:
//
//   - `amount`   = the value in that currency's INTEGER minor units (no floats,
//                  per the money rule in CLAUDE.md / lib/money). It is NEVER a
//                  pre-formatted display string.
//   - `currency` = the ISO-4217 code the amount is denominated in.
//
// There is deliberately NO per-value `exponent` and NO pre-formatted `display`
// on the wire (PLAN §16.4): exponent/symbol discovery happens once, via the
// `GET /api/v1/currencies` reference endpoint (the static §7.5.1 table), so each
// amount stays small and the client resolves formatting from the code.
//
// ── Why an OBJECT per amount instead of flat `amount` + sibling `currency` ──
// We apply the rule CONSISTENTLY: each amount carries its OWN currency inline,
// rather than a flat `amount` scalar with a sibling `currency` scalar. This
// matters most for transactions, which carry TWO amounts in DIFFERENT currencies
// (the entry-currency total vs the settlement-currency total, §7.6) — nesting
// keeps each amount unambiguous and self-describing, and the same shape is used
// everywhere (balances, payers, shares, items) so there is one money contract to
// learn. §16.4's endpoint-summary table lists fields loosely
// (e.g. `{memberId,balance,currency}`); the money-on-wire bullet is the governing
// rule and this module is how we honour it.
//
// NOTE: this shape is for genuinely MONETARY values only. A charge's `value`
// (§7.2.2) can be a PERCENT rather than an amount, so it is left as a bare scalar
// in `TransactionDetailDto` — wrapping a percentage in `{ amount, currency }`
// would be a lie.

import type { CurrencyCode } from '$lib/money';

/**
 * A single monetary value on the `/api/v1` wire (PLAN §16.4): an integer
 * `amount` in minor units plus the ISO `currency` it is denominated in. See the
 * module header for why every amount is nested like this rather than flattened.
 */
export interface Money {
	/** The value in `currency`'s integer minor units (no floats). */
	readonly amount: number;
	/** The ISO-4217 code `amount` is denominated in. */
	readonly currency: CurrencyCode;
}

/**
 * Build a {@link Money} from an integer minor-unit `amount` and its `currency`.
 * A tiny pure helper so mappers read declaratively and never hand-assemble the
 * object shape inconsistently.
 */
export function money(amount: number, currency: CurrencyCode): Money {
	return { amount, currency };
}
