// "Is this custom currency already referenced?" — the one fact the manage-
// custom-currencies screen (#62) needs that the #61 service layer does not
// return (PLAN §7.5.2; ADR-0014 decision 5).
//
// WHY A SEPARATE MODULE. `lib/server/currencies.ts` already knows how to answer
// this — but it answers it INSIDE a write transaction, under a `FOR UPDATE` row
// lock, because there the answer has to be atomic with the write it guards. This
// is the other, weaker question: a READ, for rendering. The screen has to decide
// whether to show `displayCode` / decimal places as editable inputs or as
// read-only text with a reason, and whether to offer Delete at all.
//
// The answer is DELIBERATELY ADVISORY. Between this read and the user's save, a
// group-mate can record the first transaction in that currency; the screen would
// then be showing an editable field for something that just froze. That is fine
// and by design — the service re-checks under the lock and refuses with
// `CurrencyImmutableError` / `CurrencyInUseError`, which the route maps to a field
// error. This module only makes the COMMON case legible ("you can't change this,
// here's why") instead of letting the user type a value that will be rejected.
// It is never the authority, so it needs no lock and no transaction.
//
// Business logic in `lib/server/` (CLAUDE.md), so it is testable without a route.

import { inArray } from 'drizzle-orm';
import { db } from './db';
import { transactions } from './db/transactions-schema';
import { listCurrenciesForGroup, type GroupCurrency } from './currencies';

/**
 * A group's own custom currency, plus whether any transaction already references
 * it. `isReferenced` is what freezes `displayCode` + `exponent` (ADR-0014
 * decision 5) and what forbids deletion (PLAN §7.5.2).
 */
export type CustomCurrencyUsage = GroupCurrency & {
	/** Any transaction recorded in this currency — INCLUDING soft-deleted ones. */
	readonly isReferenced: boolean;
};

/**
 * This group's OWN custom currencies (never the seeded 29), each flagged with
 * whether it is already referenced by a transaction.
 *
 * Access-checked through `listCurrenciesForGroup`, so a non-member gets the same
 * `GroupAccessError` (→ 404) as everywhere else — no second, divergent §12 check.
 *
 * Soft-deleted transactions COUNT as references, matching the service's own
 * `isReferencedByTransaction`: a deleted transaction still stores amounts in this
 * currency and can be restored (PLAN §9), so its exponent must keep meaning what
 * it meant. The two rules must agree, or the screen would offer a Delete button
 * the server then refuses.
 */
export async function listCustomCurrenciesWithUsage({
	userId,
	groupId
}: {
	userId: string;
	groupId: string;
}): Promise<CustomCurrencyUsage[]> {
	const custom = (await listCurrenciesForGroup({ userId, groupId })).filter((c) => c.isCustom);

	if (custom.length === 0) {
		return [];
	}

	// One `IN (…)` over this group's codes rather than a query per row.
	const referenced = await db
		.selectDistinct({ currency: transactions.currency })
		.from(transactions)
		.where(
			inArray(
				transactions.currency,
				custom.map((c) => c.code)
			)
		);

	const inUse = new Set(referenced.map((r) => r.currency));
	return custom.map((c) => ({ ...c, isReferenced: inUse.has(c.code) }));
}
