// `/groups/[id]/transactions` — the group transaction list (task 4.7; PLAN §7,
// §10). Access-checked `load` returns the (filtered) list + the current filter
// state parsed from `url.searchParams`. The page renders a mobile-first list with
// a type/category filter and an empty state.
//
// SCOPE (4.7): list + filter by type/category. Each row links to
// `/groups/[id]/transactions/[txid]` (the view/edit page is task 4.11; the link
// can exist now). Balances/settlement (Phase 5) and the activity feed (6.2) are
// elsewhere.

import { error } from '@sveltejs/kit';
import { requireGroupAccess } from '$lib/server/access';
import { GroupAccessError } from '$lib/server/groups';
import { listTransactions, type TransactionListItem } from '$lib/server/transactions';
import { categoriesFor } from '$lib/categories';
import { getCurrency, type CurrencyCode } from '$lib/money';
import type { PageServerLoad } from './$types';

/** Parse the `type` filter from the query string (ignoring anything unrecognized). */
function parseTypeFilter(raw: string | null): 'spending' | 'transfer' | undefined {
	return raw === 'spending' || raw === 'transfer' ? raw : undefined;
}

export const load: PageServerLoad = async ({ params, locals, url }) => {
	// Centralized guard: anonymous → redirect; no-access/not-found → 404. Returns
	// the already-loaded group. THROWS control flow → outside any try/catch.
	const { user, group } = await requireGroupAccess({ locals, groupId: params.id });

	const settlementCurrency = group.settlementCurrency as CurrencyCode;
	const currency = getCurrency(settlementCurrency);

	// Filter state from the URL (server-first: links carry the filter so it works
	// without JS). An unknown type/category simply yields no filter / no matches.
	const typeFilter = parseTypeFilter(url.searchParams.get('type'));
	const categoryFilter = url.searchParams.get('category') ?? undefined;

	let transactions: TransactionListItem[];
	try {
		transactions = await listTransactions({
			userId: user.id,
			groupId: params.id,
			filters: { type: typeFilter, categoryId: categoryFilter }
		});
	} catch (e) {
		// A real access/not-found here would be a race (the group vanished between
		// the access check and the list read) — re-surface as 404; otherwise degrade
		// to an empty list rather than 500-ing the whole page (PLAN §12).
		if (e instanceof GroupAccessError) {
			error(404, 'Group not found');
		}
		transactions = [];
	}

	return {
		group: { id: group.id, name: group.name, settlementCurrency },
		currency: currency
			? { code: currency.code, symbol: currency.symbol, exponent: currency.exponent }
			: { code: settlementCurrency, symbol: settlementCurrency, exponent: 2 },
		transactions,
		filters: { type: typeFilter ?? null, category: categoryFilter ?? null },
		// The category lists drive the filter Select (only the matching set when a
		// type is active; both otherwise).
		categories: {
			spending: categoriesFor('spending').map((c) => ({ id: c.id, name: c.name, icon: c.icon })),
			transfer: categoriesFor('transfer').map((c) => ({ id: c.id, name: c.name, icon: c.icon }))
		}
	};
};
