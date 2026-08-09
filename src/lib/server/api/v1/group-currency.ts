// `v1` group-currency DTO + mapper (issue #68; PLAN §16.4, §7.5.2 "REST surface";
// ADR-0014 decision 8).
//
// The wire shape of ONE currency a group may record a transaction in: the seeded 29
// plus that group's own custom rows, as `listCurrenciesForGroup` returns them. It is
// deliberately the SAME `{ code, exponent, symbol }` triple the global
// `GET /api/v1/currencies` serves, so a client can treat both endpoints as
// `Currency[]` and needs one type, not two. The only difference is what `code` means:
//
//   - global endpoint  → an ISO-4217 code, always (the static §7.5.1 table);
//   - this endpoint    → a DISPLAY code, which is the ISO code for a seeded currency
//                        and the group's own short code (`BEER`) for a custom one.
//
// The opaque `currencies.code` is NEVER emitted (ADR-0014 decision 8): publishing it
// would make an internal identifier a permanent part of the contract, and it is the
// one thing this DTO exists to keep off the wire.
//
// ── Why `name` is dropped, and why `symbol` is NOT wrapped ───────────────────
// `name` is dropped for the same reason the global endpoint drops it: it is a UI
// label, not part of a formatting reference contract — `exponent` and `symbol` are
// what a client needs to render an amount, and the smallest surface is the smallest
// contract to keep (§16.4).
//
// `display_code` and `symbol` on a CUSTOM row ARE member-authored text (CONTEXT.md),
// which on the AGENT surface would drag in the ADR-0003 / ADR-0004 wrapping the MCP
// views apply. That wrapping is deliberately NOT applied here, and the distinction is
// not an oversight: `/api/v1` is a plain HTTP surface whose consumer is a program,
// with no prompt for injected text to reach. Wrapping is a CONNECTOR concern (PLAN
// §7.5.2 "Agent surface"). Do not "fix" this by adding authored-value envelopes —
// that would break the published `Currency`-shaped contract for no gain.

import type { GroupCurrency } from '$lib/server/currencies';

/** One currency a group may record in, as served by `/api/v1` (PLAN §16.4). */
export interface GroupCurrencyDto {
	/**
	 * The DISPLAY code (PLAN §7.5.2): the ISO code for a seeded currency, the group's
	 * own short code for one it defined. Unique within the group, and the same code
	 * every transaction in this group reports as its `currency`.
	 */
	readonly code: string;
	/** Minor units per major unit as a power of ten — `2` for `THB`, `0` for `JPY`. */
	readonly exponent: number;
	/** The display symbol (`฿`). Member-authored on a custom row — see the header. */
	readonly symbol: string;
}

/**
 * Map one row of a group's currency set to its wire {@link GroupCurrencyDto}. PURE:
 * object → object, no DB/IO.
 *
 * Reads `displayCode` and never `code`, which IS the whole point of the mapper: the
 * two are equal for a seeded row and must never be confused for a custom one.
 */
export function toGroupCurrencyDto(currency: GroupCurrency): GroupCurrencyDto {
	return {
		code: currency.displayCode,
		exponent: currency.exponent,
		symbol: currency.symbol
	};
}
