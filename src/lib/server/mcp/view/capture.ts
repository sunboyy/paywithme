// The agent-facing view of a record-later note (issue #52; PLAN §7.7, ADR-0012).
//
// "Capture" is INTERNAL vocabulary (§7.7 / CONTEXT.md). The tool NAMES
// (`create_capture` / `list_captures`) are the agent-facing API surface and are
// fixed by the ticket, but nothing this module puts in front of a reader says
// "capture": the prose says **not recorded yet**, exactly as the UI does.
//
// ── What this view deliberately does NOT carry ───────────────────────────────
// No payer, no beneficiary, no split, no rate, and NO SETTLEMENT EQUIVALENT. The
// shallowness is the spec (ADR-0012): a note that can hold a split is a second
// transaction form. The amount is passed through UNINTERPRETED — formatted at its
// own currency's exponent and nothing else. Adding a "≈ THB 1,200 in group
// currency" field here would be the exact provisional balance annotation §7.7
// forbids.
//
// ── Attribution (ADR-0003, §7.7 "Group-visible") ─────────────────────────────
// The note is MEMBER-AUTHORED TEXT, so it crosses the wire wrapped and attributed
// to the user who wrote it. Attribution is not decoration here — it is the whole
// deduplication mechanism: "Sur — dinner, ~฿1,200, not recorded yet" is what stops
// the second person who paid part of that dinner recording it twice.
//
// ── A CUSTOM currency is member-authored too (ADR-0003, ADR-0014) ────────────
// A group may define its own currency, and the web quick-capture form offers the
// group's full set — so a note CAN be denominated in one. `McpMoney` then inlines
// that currency's member-chosen DISPLAY CODE and SYMBOL as bare strings in `amount`
// (`money.ts` explains why it must), which is legal only while the same values also
// ride wrapped and attributed in the payload. That companion is `customCurrency`,
// the SAME one the transaction view carries (`custom-currency.ts`) — a view that can
// hold such an amount and omits it hands an agent unmarked member text.
//
// That is also why this view carries `notedBy`, a member DISPLAY NAME, alongside
// the envelope's id-only `author`. The envelope's rule stands untouched (the
// author is an id, never a name — `untrusted.ts` choice 2, so an attacker's chosen
// name can never be read as the provenance label): `notedBy` is a SEPARATE field,
// itself a wrapped envelope with author `unknown`, exactly as `MemberView`
// wraps the same string. It exists because `MemberView` exposes no `userId`, so an
// `author.userId` is not joinable to a person by the agent — and an attribution
// nobody can read is not attribution.

import type { Capture } from '$lib/server/captures';
import type { EntryCurrency } from '$lib/server/entry-currency';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';
import { toMcpMoney, type McpMoney } from './money';
import { toCustomCurrencyView, type CustomCurrencyView } from './custom-currency';
import {
	authorOf,
	untrusted,
	UNKNOWN_AUTHOR,
	UNTRUSTED_NOTE,
	type UntrustedText
} from './untrusted';

/** One open record-later note, as an agent sees it. */
export interface CaptureView {
	readonly id: string;
	/** UNTRUSTED (ADR-0003), attributed to the member who wrote it. The only required content. */
	readonly note: UntrustedText;
	/**
	 * The author's member display name — UNTRUSTED, author `unknown` (the domain
	 * records who wrote the NOTE, but nobody owns the NAME; see `member.ts`). `null`
	 * when the author holds no member row in this group any more.
	 */
	readonly notedBy: UntrustedText | null;
	/** TRUE when the API key's owner wrote this note. Server-derived, never from a name. */
	readonly isYours: boolean;
	/**
	 * The amount, as a decimal string in its OWN currency (ADR-0004) — or `null`,
	 * which is the ordinary case: an amount is optional on a note, and the whole
	 * point is that it can be written in a few seconds.
	 *
	 * It is APPROXIMATE and UNINTERPRETED: no rate was applied, no settlement
	 * equivalent exists, and it is in NO balance (§7.7).
	 */
	readonly amount: McpMoney | null;
	/**
	 * The entry currency's member-authored definition — present ONLY when the note is
	 * denominated in one the group defined itself (PLAN §7.5.2). Its absence is the
	 * ordinary case and means "an ISO currency, as always"; its presence is what
	 * marks the code and symbol inlined in {@link amount} as DATA, wrapped and
	 * attributed to whoever defined the currency (ADR-0003). See
	 * {@link CustomCurrencyView}.
	 */
	readonly customCurrency?: CustomCurrencyView;
	/** The real-world day the spending happened (`YYYY-MM-DD`) — §7.7's `captured_for`. */
	readonly date: string;
	/** When the note itself was written (ISO 8601) — not the real-world date above. */
	readonly notedAt: string;
}

/**
 * The `_note` `list_captures` ships IN THE PAYLOAD (ADR-0008's "restate it beside
 * the data" lever, ADR-0003's envelope note).
 *
 * ADR-0008 is explicit that ANY read tool which could tempt a client-side total
 * must carry the same steering or it reopens the hole `get_balances` closes — and
 * this list is more tempting than the transaction list, not less: the rows look
 * like expenses, they carry amounts, and a model asked "how much have I not
 * recorded?" would happily add them up. They are approximations of things that are
 * NOT in the ledger, in mixed currencies, possibly duplicating a transaction that
 * IS recorded. Adding them to anything produces a number that means nothing.
 */
export const CAPTURES_NOTE =
	'These are NOTES a member wrote to record something LATER — they are NOT ' +
	'transactions, they are in NO balance, and nothing in this list is on the ledger. ' +
	'DO NOT add these amounts up, and never combine them with a balance or a ' +
	'transaction total: an amount here is approximate, may be in any currency, and may ' +
	'describe a spending someone has already recorded properly. For any owed figure ' +
	'call `get_balances`, which computes it server-side from the ledger. ' +
	UNTRUSTED_NOTE;

/**
 * Project a stored `Capture` into the agent's view. PURE.
 *
 * `authorName` is the display name of the author's member row in this group,
 * resolved by the caller against the roster it already loaded (`null` when the
 * author has no row left). `currency` is the RESOLVED `currencies` row for
 * `capture.currency` (`lib/server/entry-currency.ts`) — the ROW, not a bare
 * descriptor, because a CUSTOM one carries the member-authored name and its author,
 * which the wrapped `customCurrency` companion needs.
 *
 * It is `undefined` when there is no amount, or when the code no longer resolves:
 * `captures.currency` is deliberately NOT a foreign key (`captures-schema.ts`), so a
 * group-defined currency deleted afterwards leaves a dangling code. Then the amount
 * is dropped rather than rendered at a guessed exponent, exactly as the web tray does
 * — a note is worth reading without its amount; an amount at the wrong scale is worse
 * than none.
 */
export function toCaptureView({
	capture,
	principal,
	authorName,
	currency
}: {
	capture: Capture;
	principal: ApiKeyPrincipal;
	authorName: string | null;
	currency?: EntryCurrency;
}): CaptureView {
	const author = authorOf(capture.createdBy, principal);
	// The amount and its wrapped currency companion are decided TOGETHER, from one
	// value: an `amount` whose code is custom can never ship without the envelope that
	// attributes that code (ADR-0003), and the companion can never appear beside no
	// amount at all.
	const money =
		capture.amountMinor !== null && currency !== undefined
			? {
					amount: toMcpMoney(capture.amountMinor, currency),
					customCurrency: toCustomCurrencyView(currency, principal)
				}
			: { amount: null, customCurrency: undefined };
	return {
		id: capture.id,
		note: untrusted(capture.note, author),
		notedBy: authorName === null ? null : untrusted(authorName, UNKNOWN_AUTHOR),
		isYours: author.kind === 'you',
		amount: money.amount,
		...(money.customCurrency ? { customCurrency: money.customCurrency } : {}),
		date: capture.capturedFor,
		notedAt: new Date(capture.createdAt).toISOString()
	};
}
