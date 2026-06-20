// `/groups/[id]` — group overview / home page.
//
// Shows a summary of the group: debt balances per member, the 5 most recent
// transactions, and the 5 most recent activity entries. This is the default
// landing page when navigating to a group.
//
// Data strategy: three parallel fetches after the single access check —
// balances + member roster (for display names), recent transactions, recent
// activity. All three degrade gracefully: a race-condition access failure
// surfaces as 404; any other error falls back to an empty list so the page
// still renders the sections that did succeed.

import { error } from '@sveltejs/kit';
import { requireGroupAccess } from '$lib/server/access';
import { GroupAccessError } from '$lib/server/groups';
import { getGroupBalances } from '$lib/server/balances';
import { listMembers } from '$lib/server/members';
import { listTransactions, type TransactionListItem } from '$lib/server/transactions';
import { listGroupActivity, type ActivityEntry } from '$lib/server/activity';
import { orderByWhoShouldPay, type MemberBalance } from '$lib/transactions/balances';
import { formatAmount, getCurrency, type CurrencyCode } from '$lib/money';
import type { PageServerLoad } from './$types';

const RECENT_LIMIT = 5;

export const load: PageServerLoad = async ({ params, locals }) => {
	// Centralized guard: anonymous → /login; no-access/not-found → 404. THROWS
	// control flow — must be outside any try/catch.
	const { user, group } = await requireGroupAccess({ locals, groupId: params.id });

	const settlementCurrency = group.settlementCurrency as CurrencyCode;
	const currency = getCurrency(settlementCurrency);

	// Fetch balances + member roster and the two recent lists in parallel.
	const [balances, members, recentTransactions, recentActivity] = await Promise.all([
		getGroupBalances({ userId: user.id, groupId: params.id }).catch((e) => {
			if (e instanceof GroupAccessError) error(404, 'Group not found');
			return [] as MemberBalance[];
		}),
		listMembers({ userId: user.id, groupId: params.id }).catch((e) => {
			if (e instanceof GroupAccessError) error(404, 'Group not found');
			return [] as Awaited<ReturnType<typeof listMembers>>;
		}),
		listTransactions({
			userId: user.id,
			groupId: params.id,
			limit: RECENT_LIMIT
		}).catch((e) => {
			if (e instanceof GroupAccessError) error(404, 'Group not found');
			return [] as TransactionListItem[];
		}),
		listGroupActivity({
			userId: user.id,
			groupId: params.id,
			limit: RECENT_LIMIT
		}).catch((e) => {
			if (e instanceof GroupAccessError) error(404, 'Group not found');
			return [] as ActivityEntry[];
		})
	]);

	// Build display-name + active-status maps from the full roster (deactivated
	// members can still carry balances, so we use the full roster, not active-only).
	const nameById = new Map(members.map((m) => [m.id, m.displayName]));
	const isActiveById = new Map(members.map((m) => [m.id, m.deactivatedAt == null]));
	const displayName = (memberId: string): string => nameById.get(memberId) ?? memberId;

	// Balance rows ordered most-negative-first (largest debtor at top), same as
	// the settle page but used here as a compact summary.
	const ordered = orderByWhoShouldPay(balances);
	const balanceRows = ordered.map((b: MemberBalance) => ({
		memberId: b.memberId,
		displayName: displayName(b.memberId),
		balance: b.balance,
		balanceFormatted: formatAmount(b.balance, settlementCurrency),
		isDebtor: b.balance < 0,
		isCreditor: b.balance > 0,
		isActive: isActiveById.get(b.memberId) ?? true
	}));

	return {
		group: { id: group.id, name: group.name, settlementCurrency },
		currency: currency
			? { code: currency.code, symbol: currency.symbol, exponent: currency.exponent }
			: { code: settlementCurrency, symbol: settlementCurrency, exponent: 2 },
		balances: balanceRows,
		recentTransactions,
		recentActivity
	};
};
