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

// ── `currency` is the DISPLAY code, never the row key (ADR-0014 decision 7) ──
// A transaction's ENTRY currency may be one the group defined itself (PLAN
// §7.5.2). Such a row is keyed by an OPAQUE generated id (`cur_9f2e…`) which is an
// internal identifier and never appears in an API response (CONTEXT.md "Display
// code"), so the transaction mappers resolve the row and emit its `display_code`
// (`BEER`). The wire shape is unchanged — it is still `{ amount, currency }`, and
// still the same string for all 29 seeded currencies, where `code == display_code`.
//
// One honest consequence: `GET /api/v1/currencies` is the STATIC §7.5.1 table
// (§16.4) and does not list a group's own currencies, so a client cannot resolve a
// custom code's exponent or symbol from it. That is deliberate — the reference
// endpoint is a global table and a custom currency is group-scoped — and it is why
// SETTLEMENT amounts, which every §8 figure is denominated in, are always one of
// the 29 (ADR-0014 decision 1): the amounts a client must be able to format are
// never affected.

/**
 * A single monetary value on the `/api/v1` wire (PLAN §16.4): an integer
 * `amount` in minor units plus the `currency` it is denominated in. See the
 * module header for why every amount is nested like this rather than flattened.
 */
export interface Money {
	/** The value in `currency`'s integer minor units (no floats). */
	readonly amount: number;
	/**
	 * The code `amount` is denominated in — the currency's DISPLAY code. An ISO-4217
	 * code for all 29 seeded currencies (and therefore for every settlement amount);
	 * a group-defined entry currency's own short code (`BEER`) otherwise, never the
	 * opaque `currencies.code` (ADR-0014 decision 7). A custom code is meaningful
	 * only inside its own group.
	 */
	readonly currency: string;
}

/**
 * Build a {@link Money} from an integer minor-unit `amount` and its `currency`.
 * A tiny pure helper so mappers read declaratively and never hand-assemble the
 * object shape inconsistently.
 *
 * `currency` must already BE the display code — resolving a transaction's entry
 * currency is the mapper's job (see `transaction-detail.ts`), not this helper's.
 */
export function money(amount: number, currency: string): Money {
	return { amount, currency };
}
