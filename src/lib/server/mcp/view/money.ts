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

// ── The code on the wire is the DISPLAY code, never the row key (ADR-0014 #7) ──
// A transaction's ENTRY currency may be one a group defined itself (PLAN §7.5.2),
// which lives only as a `currencies` row keyed by an OPAQUE generated id
// (`cur_9f2e…`). That id is an internal identifier — never shown, never spoken
// about (CONTEXT.md "Display code") — and to a model it is a meaningless token it
// cannot say back to the user. So this module resolves and emits `display_code`
// (`BEER`), and marks the value as custom so the model knows the code is
// GROUP-SCOPED: `BEER` in one group and `BEER` in another are different units,
// and neither is ISO 4217.
//
// The display code and the symbol are MEMBER-AUTHORED TEXT, and they are inlined
// here as bare substrings of `currency` / `display`. That is the same bargain
// `echo.ts` strikes with member names in prose (ADR-0003): legibility requires the
// text be readable in place, and it is legal ONLY because the same values ALSO
// ride WRAPPED and attributed in the structured payload — `customCurrency` on the
// transaction view — and the result carries `UNTRUSTED_NOTE`. A `_untrusted`
// envelope in `currency` would instead break the one field a model must be able to
// pair with `amount` mechanically.

import {
	formatAmount,
	isCustomCurrency,
	toCurrencyDescriptor,
	type CurrencyDescriptor,
	type EntryCurrencyCode
} from '$lib/money';

/** One monetary value as an agent sees it (ADR-0004). Three renderings, no integers. */
export interface McpMoney {
	/**
	 * The amount as a DECIMAL string at the currency's own precision, e.g.
	 * `"240.00"` (THB, exponent 2), `"240"` (JPY, exponent 0), `"-1200.00"` (a debt).
	 * Ungrouped, so it round-trips back into a write tool's `amount` argument
	 * verbatim.
	 */
	readonly amount: string;
	/**
	 * The code `amount` is denominated in — always the DISPLAY code (`THB`, `BEER`),
	 * never the opaque `currencies.code` of a group-defined row (ADR-0014 decision
	 * 7). An ISO-4217 code unless {@link isCustom} is set, in which case it is a
	 * code THIS GROUP chose and it means nothing outside this group.
	 */
	readonly currency: string;
	/** A ready-to-quote human rendering, e.g. `"THB ฿1,200.00"` — symbol + grouping. */
	readonly display: string;
	/**
	 * Present, and `true`, ONLY when `currency` is a currency the group defined
	 * itself (PLAN §7.5.2) rather than one of the 29 ISO currencies. Absent on every
	 * ordinary amount, so its presence is the signal: this code is group-scoped, must
	 * never be carried to another group, and can never be a group's settlement
	 * currency — which is why a balance never carries it.
	 */
	readonly isCustom?: true;
}

/**
 * Project integer minor units into the agent-facing money shape. PURE.
 *
 * Takes either a seeded code or an already-resolved {@link CurrencyDescriptor}
 * (`lib/money`'s `CurrencyRef`). The descriptor form is the one a group-defined
 * custom currency needs: its code is not in the compiled-in seeded table, so
 * passing the bare code THROWS rather than emitting anything — the read surfaces
 * resolve the row first (`lib/server/entry-currency.ts`). The currency's exponent
 * comes from whichever form was passed, so a 0-decimal currency (JPY/KRW/VND, or a
 * custom `BEER`) renders with no decimal point.
 *
 * Negative amounts are supported and keep their sign (`"-1200.00"`) — a balance is
 * signed (§8.1), and hiding that sign would be the single most dangerous thing this
 * module could do.
 */
export function toMcpMoney(
	minor: number,
	currency: EntryCurrencyCode | CurrencyDescriptor
): McpMoney {
	const resolved = toCurrencyDescriptor(currency);
	const custom = isCustomCurrency(resolved);
	return {
		amount: formatAmount(minor, resolved, { symbol: false, grouped: false }),
		currency: resolved.displayCode,
		display: formatAmount(minor, resolved),
		...(custom ? { isCustom: true as const } : {})
	};
}
