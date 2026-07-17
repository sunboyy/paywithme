// Money on the MCP wire — a DECIMAL STRING, never minor units (ADR-0004).
//
// This is the sharpest of the deliberate divergences from `/api/v1` (ADR-0006).
// REST serves `{ amount: 24000, currency: 'THB' }` — integer minor units, the
// correct contract for a developer reading an OpenAPI spec. A language model does
// not read the spec; it pattern-matches the field name against the user's words,
// and "240 baht" against `amount` gives `240` — which THB reads as ฿2.40 and JPY
// reads, correctly, as ¥240. A silent 100× error in a money ledger, whose sign and
// size depend on the currency's exponent.
//
// So the model never sees, and never computes, minor units. It sees what a person
// would say — `"240.00"` — plus a `display` string it can quote back verbatim. The
// exponent math stays inside `lib/money` (`formatAmount`), on integers, on the
// server. PLAN's no-floats invariant is untouched: this module CONSUMES an integer
// and EMITS a string; it never does arithmetic.
//
// `/api/v1`'s `Money` DTO is not touched — it cannot be, it is a published
// contract with an OpenAPI spec. The two shapes coexist by design.

import { formatAmount, type CurrencyCode } from '$lib/money';

/** One monetary value as an agent sees it (ADR-0004). Three renderings, no integers. */
export interface McpMoney {
	/**
	 * The amount as a DECIMAL string at the currency's own precision, e.g.
	 * `"240.00"` (THB, exponent 2), `"240"` (JPY, exponent 0), `"-1200.00"` (a debt).
	 * Ungrouped, so it round-trips back into a write tool's `amount` argument
	 * verbatim.
	 */
	readonly amount: string;
	/** The ISO-4217 code `amount` is denominated in. */
	readonly currency: CurrencyCode;
	/** A ready-to-quote human rendering, e.g. `"THB ฿1,200.00"` — symbol + grouping. */
	readonly display: string;
}

/**
 * Project integer minor units into the agent-facing money shape. PURE. The
 * currency's exponent is read from the canonical `lib/money` table, so a
 * 0-decimal currency (JPY/KRW/VND) renders with no decimal point and a future
 * 3-decimal currency would need no change here.
 *
 * Negative amounts are supported and keep their sign (`"-1200.00"`) — a balance is
 * signed (§8.1), and hiding that sign would be the single most dangerous thing this
 * module could do.
 */
export function toMcpMoney(minor: number, currency: CurrencyCode): McpMoney {
	return {
		amount: formatAmount(minor, currency, { symbol: false, grouped: false }),
		currency,
		display: formatAmount(minor, currency)
	};
}
