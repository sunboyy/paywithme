// Resolving a transaction's ENTRY currency for the READ surfaces (issue #64;
// PLAN §7.5.2 "Agent / API surface"; ADR-0014 decision 7).
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
// `display_code`. WRITES need nothing from this module and must not grow a
// dependency on it: assistant writes are restricted to the group settlement
// currency, which is always seeded (ADR-0014 decisions 1 + 7).
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
