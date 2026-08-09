// Translating a transaction's ENTRY currency between the wire and the ledger
// (issues #64, #68; PLAN §7.5.2 "Agent surface" / "REST surface"; ADR-0014
// decisions 7 + 8).
//
// ── The leak this module exists to close ─────────────────────────────────────
// `transactions.currency` holds a `currencies.code`. For one of the seeded 29 that
// IS the user-visible code (`THB`), but for a group-defined custom currency it is
// the OPAQUE generated primary key (`cur_9f2e…`) — an internal identifier that
// CONTEXT.md ("Display code") says is never shown, never typed and never spoken
// about. Emitting it on `/api/v1` or through the Connector would be a meaningless
// string on the wire in place of the thing the member actually named (`BEER`).
//
// So every read surface that serves a transaction resolves the row first and emits
// `display_code`.
//
// ── Both directions, because `/api/v1` speaks display code on the way IN too ──
// This module originally said writes needed nothing from it. That reasoned from the
// Connector — assistant writes are settlement-currency-only, which is always seeded
// (ADR-0014 decision 1) — and it is still true THERE. It was never true of
// `/api/v1`, which has no such restriction: once reads emitted only `display_code`,
// a client could read `3 BEER` and had nothing valid to `PUT` back, because `PUT` is
// a full replacement and the opaque code is (deliberately) undiscoverable.
// ADR-0014 decision 8 closes that by making the REST write path speak display code
// as well, so this module owns the INVERSE mapping too:
//
//   READ   `transactions.currency` (a `currencies.code`) → `EntryCurrency.displayCode`
//   WRITE  a body's `currency` (a display code)          → `currencies.code`
//
// The write direction lives here, next to the read one, so the two halves of one
// translation can never drift. It is a ROUTE-BOUNDARY concern: nothing in
// `lib/server/transactions.ts` changes — `createTransaction` / `updateTransaction`
// already build their entry-currency gate from the group's own set — so the routes
// translate BEFORE calling the service and the service keeps seeing internal keys
// only. The Connector does not call it (decision 1 stands).
//
// ── Why this is not an N+1 ───────────────────────────────────────────────────
// `list_transactions` / `GET …/transactions` serve up to 100 rows, so a
// per-row lookup would be a per-row query. Two things prevent that, in the order
// they apply — the SAME two the write path's `resolveEntryCurrencies` in
// `transactions.ts` applies, deliberately mirrored so the read and write halves of
// §7.5.2 behave alike:
//
//   1. THE SEEDED FAST PATH. The 29 seeded descriptors are compiled in
//      (`SEEDED_CURRENCY_DESCRIPTORS`), so a page whose every row is denominated in
//      a seeded currency — which is every page, in every group that never opened
//      the custom-currency UI — issues NO query at all.
//   2. ONE QUERY FOR THE WHOLE PAGE. When at least one code is not seeded we read
//      the group's custom rows ONCE and index them by code, then answer every row
//      from that index. The cost is O(1) queries per request, not O(rows).
//
// ── Authorization ────────────────────────────────────────────────────────────
// This module does NOT access-check, because every caller has already read the
// transactions it is resolving currencies for through an access-checked service
// (`getTransactionDetail` / `listTransactions`), and re-checking would add a query
// to close nothing. The query is `group_id`-scoped regardless, so it can only ever
// return the caller's own group's rows plus the global seeded ones — a code from
// another group is simply absent, exactly as it is on the write path.
//
// The WRITE direction does not access-check either, and cannot leak by not doing so:
// it returns nothing to the caller, and the service it feeds asserts membership
// before it validates anything, so a non-member's write is the same 404 whether
// their code translated or not.

import { eq } from 'drizzle-orm';
import { db } from './db';
import { currencies } from './db/currencies-schema';
import { CURRENCIES, getCurrency, type CurrencyDescriptor } from '$lib/money';

/**
 * A resolved entry currency, as the read surfaces need it: everything
 * {@link CurrencyDescriptor} carries (so it drops straight into `formatAmount`),
 * plus the two fields the AGENT view additionally has to serve.
 *
 * `name` and `createdBy` are here for ADR-0003: on a custom row the display code,
 * the name and the symbol are all MEMBER-AUTHORED TEXT (CONTEXT.md), so the MCP
 * view wraps them and attributes them to the member who defined the currency.
 * `/api/v1` needs neither — it emits `displayCode` and nothing else.
 */
export interface EntryCurrency extends CurrencyDescriptor {
	/** Human-readable name (`'Thai Baht'`, `'Bottle of beer'`). Member-authored on a custom row. */
	readonly name: string;
	/** Who defined it; `null` for a seeded row — nobody authored those. */
	readonly createdBy: string | null;
}

/**
 * Resolve one already-requested code to its {@link EntryCurrency}.
 *
 * @throws if the code was not among the `codes` the lookup was built for, or names
 *   no currency this group may use. Both are contract violations —
 *   `transactions.currency` is a foreign key to `currencies.code` and a custom row
 *   cannot be deleted while referenced — and failing loudly is the only safe
 *   answer: the tempting fallbacks are to display the opaque `code` (forbidden) or
 *   to invent an exponent (renders every amount at the wrong scale).
 */
export type EntryCurrencyLookup = (code: string) => EntryCurrency;

/** Widen a compiled-in seeded currency; seeded rows satisfy `code == display_code`. */
function seededEntryCurrency(code: string): EntryCurrency | undefined {
	const seeded = getCurrency(code);
	if (seeded === undefined) return undefined;
	return {
		code: seeded.code,
		displayCode: seeded.code,
		name: seeded.name,
		exponent: seeded.exponent,
		symbol: seeded.symbol,
		createdBy: null
	};
}

/** Every seeded currency, indexed once at module load — the fast path's whole cost. */
const SEEDED_ENTRY_CURRENCIES: ReadonlyMap<string, EntryCurrency> = new Map(
	CURRENCIES.map((c) => [
		c.code,
		{
			code: c.code,
			displayCode: c.code,
			name: c.name,
			exponent: c.exponent,
			symbol: c.symbol,
			createdBy: null
		} satisfies EntryCurrency
	])
);

/**
 * Build a {@link EntryCurrencyLookup} covering every code in `codes` — the
 * page-at-a-time resolver the transaction LIST surfaces use.
 *
 * Reads the `currencies` table AT MOST ONCE, and not at all when every code is one
 * of the seeded 29 (see the module header). Pass the codes of the whole page, then
 * resolve each row against the returned lookup.
 *
 * The caller must already have established the user's access to `groupId`.
 */
export async function resolveEntryCurrencies(
	groupId: string,
	codes: Iterable<string>
): Promise<EntryCurrencyLookup> {
	const wanted = new Set(codes);
	const resolved = new Map<string, EntryCurrency>();
	let needsCustom = false;

	for (const code of wanted) {
		const seeded = SEEDED_ENTRY_CURRENCIES.get(code);
		if (seeded) {
			resolved.set(code, seeded);
		} else {
			needsCustom = true;
		}
	}

	if (needsCustom) {
		// ONE query for the whole page — the group's custom rows only. Seeded rows are
		// already answered from the compiled-in table above, so there is no reason to
		// re-read the 29 from the database.
		const rows = await db
			.select({
				code: currencies.code,
				displayCode: currencies.displayCode,
				name: currencies.name,
				exponent: currencies.exponent,
				symbol: currencies.symbol,
				createdBy: currencies.createdBy
			})
			.from(currencies)
			.where(eq(currencies.groupId, groupId));

		for (const row of rows) {
			if (wanted.has(row.code)) {
				resolved.set(row.code, row);
			}
		}
	}

	return (code: string): EntryCurrency => {
		const match = resolved.get(code) ?? seededEntryCurrency(code);
		if (match === undefined) {
			throw new Error(`Transaction currency is not in this group's currency set: ${code}`);
		}
		return match;
	};
}

/**
 * Resolve a SINGLE transaction's entry currency — the detail surfaces' form of
 * {@link resolveEntryCurrencies}. Costs no query when the code is seeded.
 *
 * The caller must already have established the user's access to `groupId`.
 */
export async function resolveEntryCurrency(groupId: string, code: string): Promise<EntryCurrency> {
	const lookup = await resolveEntryCurrencies(groupId, [code]);
	return lookup(code);
}

// ── THE WRITE DIRECTION (issue #68; ADR-0014 decision 8) ─────────────────────

/**
 * What a display code that names NOTHING in this group resolves to.
 *
 * A failed translation must not be signalled by a new error class or a distinct
 * message: PLAN §7.5.2 requires an unknown code, ANOTHER GROUP's code and a
 * client-supplied opaque `cur_…` to be ONE indistinguishable outcome (the same
 * don't-leak discipline §12 applies to group existence). The cheapest way to get
 * that for free is to hand the service a value its own gate is guaranteed to
 * reject, so the failure surfaces as the ORDINARY entry-currency validation error
 * — `UNSUPPORTED_CURRENCY_MESSAGE` on the `currency` field, a 422 — byte-identical
 * to the one an unknown code produced before this feature existed.
 *
 * The empty string is guaranteed absent from every group's set: a seeded code is
 * three letters and a custom row's code is a generated `cur_…` (never empty, and
 * never accepted from a caller — see `currencies.ts`).
 */
const UNRESOLVABLE_ENTRY_CURRENCY = '';

/**
 * Translate ONE display code to the `currencies.code` the ledger stores it under —
 * the inverse of {@link resolveEntryCurrency} (ADR-0014 decision 8).
 *
 * Resolution is unambiguous because both properties it needs are already enforced
 * (#61): `(group_id, display_code)` is unique, AND a display code may not shadow one
 * of the seeded 29 — so within one group a display code names EXACTLY ONE currency.
 * It is also stable: `display_code` freezes the moment a transaction references the
 * row (decision 5), so the code a client read a transaction under cannot move
 * underneath it before the client writes it back.
 *
 * Returns {@link UNRESOLVABLE_ENTRY_CURRENCY} when the code names nothing this group
 * may record in — including the opaque `cur_…` key itself, which is REJECTED on
 * purpose: accepting both vocabularies would make the internal identifier a de-facto
 * part of the contract, which is exactly what decision 8 refuses.
 *
 * Costs NO query for a seeded code (`code == display_code`), which is every write
 * from every group that never opened the custom-currency UI.
 */
export async function resolveWriteCurrencyCode(
	groupId: string,
	displayCode: string
): Promise<string> {
	// Seeded fast path: `code == display_code`, so the translation is the identity
	// and no group-scoped row can shadow it (#61 forbids a custom row from taking a
	// seeded display code).
	if (SEEDED_ENTRY_CURRENCIES.has(displayCode)) return displayCode;

	// ONE group-scoped query. It can only ever see this group's own custom rows, so
	// another group's display code is simply absent — nothing leaks about whether it
	// exists elsewhere.
	const rows = await db
		.select({ code: currencies.code, displayCode: currencies.displayCode })
		.from(currencies)
		.where(eq(currencies.groupId, groupId));

	const match = rows.find((row) => row.displayCode === displayCode);
	return match?.code ?? UNRESOLVABLE_ENTRY_CURRENCY;
}

/**
 * Translate a `/api/v1` transaction WRITE BODY's `currency` from the display code
 * the client speaks to the internal key the ledger stores (ADR-0014 decision 8).
 *
 * Call this at the route boundary, with the `{gid}` already in the URL path, BEFORE
 * handing the body to `createTransaction` / `updateTransaction`: the service then
 * validates the translated key against the group's own set exactly as it always
 * has, so a bad code is the ordinary 422 and no service signature changes.
 *
 * Everything else about the body is passed through untouched — this is the ONE
 * documented substitution §16.4 allows on the "write payload = the full internal
 * `TransactionInput` verbatim" rule.
 *
 * A body that is not an object, or whose `currency` is not a string, is returned
 * AS-IS: there is nothing to translate, and the shared schema already rejects it
 * with the same message.
 *
 * NOTE for the caller: the §16.6 idempotency fingerprint is taken from the RAW
 * REQUEST BYTES, before this runs, and must stay that way — a fingerprint computed
 * after translation would depend on server state rather than on what the client
 * sent.
 */
export async function resolveWriteCurrency(groupId: string, input: unknown): Promise<unknown> {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;

	const submitted = (input as { currency?: unknown }).currency;
	if (typeof submitted !== 'string') return input;

	const code = await resolveWriteCurrencyCode(groupId, submitted);
	// Seeded (the overwhelmingly common case): the translation is the identity, so
	// hand the service the very object the client sent rather than a copy of it.
	if (code === submitted) return input;

	return { ...input, currency: code };
}
