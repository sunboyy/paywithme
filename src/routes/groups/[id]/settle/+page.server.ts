// `/groups/[id]/settle` — debt summary + settlement suggestions (task 5.4;
// PLAN §8, §8.2, §8.4, §10).
//
// Server-first read-only page: `load` guards with `requireGroupAccess`, computes
// the group's NET balances in SETTLEMENT-currency minor units (the §8.1 query),
// joins member display names, and produces TWO views of the §8 math:
//
//   1. The "who should pay" balances list (PLAN §8.2): every member ordered by
//      balance ASCENDING — the most negative (largest debtor) first — with a
//      signed, formatted settlement-currency amount. Surfaced prominently.
//   2. The simplified settlement suggestions (PLAN §8.3): a minimal set of
//      "{debtor} pays {creditor} {amount}" transfers, each carrying the from/to
//      member ids + the raw minor-unit amount so the §8.4 "Settle up" action can
//      prefill a Transfer at `/groups/[id]/transactions/new` (NO float parsing —
//      the amount stays an integer end to end).
//
// This page NEVER persists a settlement — saving goes through the existing
// `createTransaction` action unchanged (§8.4: "on save it's a normal
// transaction, so balances recompute and the suggestion list shrinks"). The
// audit-log UI (Phase 6) is NOT built here.

import { formatAmount, getCurrency, type CurrencyCode } from '$lib/money';
import { requireGroupAccess } from '$lib/server/access';
import { getGroupBalances } from '$lib/server/balances';
import { listMembers } from '$lib/server/members';
import {
	orderByWhoShouldPay,
	suggestSettlements,
	type MemberBalance
} from '$lib/transactions/balances';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	// Centralized guard (task 3.8): anonymous → /login; no-access/not-found → 404.
	// Returns the already-loaded group so we don't re-query. THROWS control flow,
	// so it stays outside any try/catch.
	const { user, group } = await requireGroupAccess({ locals, groupId: params.id });

	const settlementCurrency = group.settlementCurrency as CurrencyCode;
	const currency = getCurrency(settlementCurrency);

	// §8.1 net balances (settlement minor units, sums to 0, excludes soft-deleted
	// txns) + the member roster for display names. Both are access-checked again
	// inside, but the guard above already established access.
	const balances = await getGroupBalances({ userId: user.id, groupId: params.id });
	const members = await listMembers({ userId: user.id, groupId: params.id });

	// memberId → display name. Members can be deactivated yet still carry a balance
	// (they stay in the ledger, §6.3), so we map over the FULL roster, not just the
	// active subset. A missing name (defensive) falls back to the id.
	const nameById = new Map(members.map((m) => [m.id, m.displayName]));
	const displayName = (memberId: string): string => nameById.get(memberId) ?? memberId;

	// ── §8.2 "who should pay": order by balance ASCENDING (most negative first). ──
	// Each row carries the raw signed balance (minor units) + a formatted display
	// string in the settlement currency. `formatAmount` handles the sign, so a
	// debtor reads e.g. "-฿120.00" and a creditor "฿120.00".
	const ordered = orderByWhoShouldPay(balances);
	const balanceRows = ordered.map((b: MemberBalance) => ({
		memberId: b.memberId,
		displayName: displayName(b.memberId),
		// Raw signed minor units (no floats) — the UI can branch on sign.
		balance: b.balance,
		balanceFormatted: formatAmount(b.balance, settlementCurrency),
		// Convenience flags for the prominent "who owes / who is owed" summary (§8.2).
		isDebtor: b.balance < 0,
		isCreditor: b.balance > 0
	}));

	// ── §8.3 simplified settlements → §8.4 prefill rows. ─────────────────────────
	// Each suggestion renders as "{debtor} pays {creditor} {amount}" and carries the
	// from/to ids + raw minor-unit amount so the "Settle up" link can seed a Transfer
	// without re-deriving anything (and with NO float parsing).
	const suggestions = suggestSettlements(balances).map((s) => ({
		fromMemberId: s.fromMemberId,
		toMemberId: s.toMemberId,
		fromDisplayName: displayName(s.fromMemberId),
		toDisplayName: displayName(s.toMemberId),
		// Raw settlement minor units — fed straight into the prefill query string.
		amount: s.amount,
		amountFormatted: formatAmount(s.amount, settlementCurrency)
	}));

	return {
		group: { id: group.id, name: group.name, settlementCurrency },
		currency: currency
			? { code: currency.code, symbol: currency.symbol, exponent: currency.exponent }
			: { code: settlementCurrency, symbol: settlementCurrency, exponent: 2 },
		balances: balanceRows,
		suggestions,
		// All settled up when there are NO suggested transfers — i.e. every balance is
		// ~0 (the §8.3 greedy matcher emits nothing when no one is in the red). The
		// empty-state copy keys off this single flag (§8.4 empty state).
		allSettled: suggestions.length === 0
	};
};
