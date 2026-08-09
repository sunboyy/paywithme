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
import { pathAndQuery } from '$lib/redirect';
import { GroupAccessError } from '$lib/server/groups';
import { getGroupBalances } from '$lib/server/balances';
import { listMembers } from '$lib/server/members';
import { listTransactions, type TransactionListItem } from '$lib/server/transactions';
import { resolveEntryCurrencies } from '$lib/server/entry-currency';
import { listGroupActivity, type ActivityEntry } from '$lib/server/activity';
import { orderByWhoShouldPay, type MemberBalance } from '$lib/transactions/balances';
import { formatAmount, getCurrency, type SeededCurrencyCode } from '$lib/money';
import type { PageServerLoad } from './$types';

const RECENT_LIMIT = 5;

/** What the page needs to format one row's original amount — a `CurrencyDescriptor`. */
export interface RecentEntryCurrency {
	code: string;
	displayCode: string;
	symbol: string;
	exponent: number;
}

/**
 * Resolve the entry-currency descriptor of every DISTINCT code among the recent
 * rows (PLAN §7.5.2 / ADR-0014 decision 4). One lookup for the whole list, and none
 * at all when every code is seeded — see the call site for why the page cannot
 * format from the bare code.
 */
async function resolveRecentCurrencies(
	groupId: string,
	rows: readonly TransactionListItem[]
): Promise<RecentEntryCurrency[]> {
	const codes = [...new Set(rows.map((t) => t.currency))];
	if (codes.length === 0) return [];
	const lookup = await resolveEntryCurrencies(groupId, codes);
	return codes.map((code) => {
		const c = lookup(code);
		return { code: c.code, displayCode: c.displayCode, symbol: c.symbol, exponent: c.exponent };
	});
}

export const load: PageServerLoad = async ({ params, locals, url }) => {
	// Centralized guard: anonymous → /login; no-access/not-found → 404. THROWS
	// control flow — must be outside any try/catch.
	const { user, group } = await requireGroupAccess({
		locals,
		groupId: params.id,
		redirectTo: pathAndQuery(url)
	});

	const settlementCurrency = group.settlementCurrency as SeededCurrencyCode;
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

	// ── The ENTRY currency of each recent row (PLAN §7.5.2; issue #69 finding 2) ──
	// A row shows its ORIGINAL amount in the currency it was RECORDED in (§7.6
	// "Display"), and that may be one this group defined itself — which exists only as
	// a `currencies` row. `formatAmount` is given a bare code here, and a custom code
	// resolves to nothing in the compiled-in seeded constant, so it THROWS by design
	// (guessing an exponent would render every amount at the wrong scale). Without
	// these descriptors the whole overview 500s the moment a custom-currency
	// transaction is among the five most recent — ordinary use of the feature.
	//
	// `resolveEntryCurrencies` (not `listCurrenciesForGroup`) because of its seeded
	// fast path: when every recent row is denominated in one of the 29 — every group
	// that never opened the custom-currency UI — it issues NO query at all.
	//
	// NOT degraded to an empty list on failure, for the same reason the transaction
	// list page does not: a missing descriptor does not make the page render one
	// section less, it makes the component throw anyway, later and with a worse
	// message. Access is already established, and the codes come from rows we just
	// read behind a foreign key, so a failure here is a real fault.
	const recentCurrencies = await resolveRecentCurrencies(params.id, recentTransactions);

	// Build display-name + active-status maps from the full roster (deactivated
	// members can still carry balances, so we use the full roster, not active-only).
	const nameById = new Map(members.map((m) => [m.id, m.displayName]));
	const isActiveById = new Map(members.map((m) => [m.id, m.deactivatedAt == null]));
	const displayName = (memberId: string): string => nameById.get(memberId) ?? memberId;

	// The caller's own member row in this group, if they have one. Read off the
	// roster we already fetched rather than issuing another query.
	const viewerMemberId = members.find((m) => m.userId === user.id)?.id;

	// Balance rows ordered most-negative-first (largest debtor at top), same as
	// the settle page but used here as a compact summary.
	const ordered = orderByWhoShouldPay(balances);
	const balanceRows = ordered.map((b: MemberBalance) => ({
		memberId: b.memberId,
		displayName: displayName(b.memberId),
		balance: b.balance,
		// `code: false`: every balance here is in THIS group's settlement currency,
		// which the page states once — so the rows read "-¥21,560", not the
		// redundant "JPY ¥-21,560".
		balanceFormatted: formatAmount(b.balance, settlementCurrency, { code: false }),
		isDebtor: b.balance < 0,
		isCreditor: b.balance > 0,
		isActive: isActiveById.get(b.memberId) ?? true,
		// Marks the viewer's own row so the list can call it out — without this the
		// only way to find yourself is to recognise your own name among the others.
		isYou: viewerMemberId !== undefined && b.memberId === viewerMemberId
	}));

	// ── The viewer's OWN position (the reason the page gets opened) ───────────────
	// Derived from the roster already loaded above (the member row whose `userId`
	// is the caller) plus the balances already computed — no extra query. A user
	// with no member row in this group (possible for a soft-deactivated member)
	// simply gets no summary rather than a wrong one.
	const you = balances.find((b: MemberBalance) => b.memberId === viewerMemberId);
	const yourBalance = you?.balance ?? null;
	const summary =
		yourBalance === null
			? null
			: {
					balance: yourBalance,
					// Absolute value: the label supplies the direction ("you are owed"),
					// so a signed figure beside it would read as a double negative.
					amountFormatted: formatAmount(Math.abs(yourBalance), settlementCurrency, {
						code: false
					}),
					// How many people are on the other side of that number — the natural
					// follow-up question ("owed by whom?").
					counterparties: balanceRows.filter(
						(r) => !r.isYou && (yourBalance > 0 ? r.isDebtor : r.isCreditor)
					).length
				};

	return {
		group: { id: group.id, name: group.name, settlementCurrency },
		summary,
		currency: currency
			? { code: currency.code, symbol: currency.symbol, exponent: currency.exponent }
			: { code: settlementCurrency, symbol: settlementCurrency, exponent: 2 },
		balances: balanceRows,
		recentTransactions,
		// One descriptor per DISTINCT entry currency among the rows above; the page
		// indexes them by `code` to format each row's original amount.
		recentCurrencies,
		recentActivity
	};
};
