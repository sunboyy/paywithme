// `/groups/[id]/transactions` — the group transaction list (task 4.7; PLAN §7,
// §10). Access-checked `load` returns the (filtered) list + the current filter
// state parsed from `url.searchParams`. The page renders a mobile-first list with
// a type/category/member filter and an empty state.
//
// SCOPE (4.7): list + filter by type/category, later extended with the §10 MEMBER
// filter ("show only what relates to me" — a member id plus an optional `role`
// narrowing it to the paying or the benefiting side). Each row links to
// `/groups/[id]/transactions/[txid]` (the view/edit page is task 4.11; the link
// can exist now). Balances/settlement (Phase 5) and the activity feed (6.2) are
// elsewhere.

import { error } from '@sveltejs/kit';
import { requireGroupAccess } from '$lib/server/access';
import { GroupAccessError } from '$lib/server/groups';
import { listTransactions, type TransactionListItem } from '$lib/server/transactions';
import { listMembers } from '$lib/server/members';
import { categoriesFor } from '$lib/categories';
import { getCurrency, type CurrencyCode } from '$lib/money';
import type { PageServerLoad } from './$types';

/** Parse the `type` filter from the query string (ignoring anything unrecognized). */
function parseTypeFilter(raw: string | null): 'spending' | 'transfer' | undefined {
	return raw === 'spending' || raw === 'transfer' ? raw : undefined;
}

/**
 * Parse the `role` filter — which SIDE of the transaction the `member` filter means
 * (`paid` = they paid, `owes` = they benefited). Anything unrecognized (including
 * absent) is `undefined`, i.e. EITHER side: the "relates to me" default.
 */
function parseRoleFilter(raw: string | null): 'paid' | 'owes' | undefined {
	return raw === 'paid' || raw === 'owes' ? raw : undefined;
}

/** One entry in the member filter's dropdown. */
export interface MemberFilterOption {
	id: string;
	displayName: string;
	/** The viewer's OWN member slot — pinned first and labelled "Me". */
	isSelf: boolean;
	/** Soft-deactivated (§6.3). Still filterable: they keep their history. */
	isInactive: boolean;
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
	// "Only what relates to <person>": a member id, optionally narrowed to one side
	// by `role`. An unknown member id simply matches nothing (same as an unknown
	// category); a `role` without a `member` has no meaning and is dropped here so
	// it can never reach the service.
	const memberFilter = url.searchParams.get('member') || undefined;
	const roleFilter = memberFilter ? parseRoleFilter(url.searchParams.get('role')) : undefined;

	let transactions: TransactionListItem[];
	try {
		transactions = await listTransactions({
			userId: user.id,
			groupId: params.id,
			filters: {
				type: typeFilter,
				categoryId: categoryFilter,
				memberId: memberFilter,
				memberRole: roleFilter
			}
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

	// The people the member filter can select. Deactivated members are INCLUDED —
	// they keep their historical transactions (§6.3), so hiding them would make
	// their rows unreachable from this filter. A read failure here degrades to "no
	// member filter offered" rather than 500-ing a page whose list already loaded.
	let members: MemberFilterOption[];
	try {
		const rows = await listMembers({ userId: user.id, groupId: params.id });
		members = rows.map((m) => ({
			id: m.id,
			displayName: m.displayName,
			isSelf: m.userId === user.id,
			isInactive: m.deactivatedAt !== null
		}));
	} catch {
		members = [];
	}

	return {
		group: { id: group.id, name: group.name, settlementCurrency },
		currency: currency
			? { code: currency.code, symbol: currency.symbol, exponent: currency.exponent }
			: { code: settlementCurrency, symbol: settlementCurrency, exponent: 2 },
		transactions,
		members,
		filters: {
			type: typeFilter ?? null,
			category: categoryFilter ?? null,
			member: memberFilter ?? null,
			role: roleFilter ?? null
		},
		// The category lists drive the filter Select (only the matching set when a
		// type is active; both otherwise).
		categories: {
			spending: categoriesFor('spending').map((c) => ({ id: c.id, name: c.name, icon: c.icon })),
			transfer: categoriesFor('transfer').map((c) => ({ id: c.id, name: c.name, icon: c.icon }))
		}
	};
};
