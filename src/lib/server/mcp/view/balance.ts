// The agent-facing BALANCES view (ADR-0006, ADR-0008) — the ONLY authoritative
// answer to "how much do I owe?".
//
// ── What ADR-0008 is defending against ──────────────────────────────────────
// No attacker, no bug: the agent lists a page of transactions, sums what it has,
// converts currencies in its head, and announces "You owe ฿3,400" when the truth is
// ฿9,150. It states the wrong number with total confidence, and the user has no
// reason to doubt it.
//
// The figures below come from `getGroupBalances` — the same server-side computation
// (§8.1: Σ paid − Σ owed per member, in the group's settlement currency, over
// non-deleted transactions, in integer minor units) that the web app renders. This
// view NEVER re-derives, re-sums, or converts anything. It re-shapes.
//
// ── Why the view carries prose and a direction ──────────────────────────────
// A signed integer is a poor thing to hand a language model: `-120000` invites the
// model to decide what the sign means and then to phrase it. So each line states its
// `direction` explicitly ('owes' / 'is_owed' / 'settled'), and the caller's own line
// comes with a ready-made `summary` sentence — the one figure the user actually
// asked for, already worded, so the model quotes rather than reasons.

import type { CurrencyCode } from '$lib/money';
import type { MemberBalance } from '$lib/transactions/balances';
import { toMcpMoney, type McpMoney } from './money';
import type { GroupView } from './group';
import type { MemberView } from './member';
import { untrusted, UNTRUSTED_NOTE, PAYWITHME_AUTHOR, type UntrustedText } from './untrusted';

/** Which way a net balance points (§8.1). Stated, so the model never infers it from a sign. */
export type BalanceDirection = 'owes' | 'is_owed' | 'settled';

/** One member's net position in the group. */
export interface BalanceLineView {
	readonly memberId: string;
	/** UNTRUSTED (ADR-0003) — a member's display name is text somebody typed. */
	readonly displayName: UntrustedText;
	/** TRUE on exactly one line: the API key's owner (see `member.ts`). */
	readonly isYou: boolean;
	/** Net balance, SIGNED, in the group's settlement currency: + is owed, − owes. */
	readonly balance: McpMoney;
	/** The sign, spelled out. */
	readonly direction: BalanceDirection;
}

/** The caller's own position — the answer to "what do I owe?", pre-worded. */
export interface SelfBalanceView {
	readonly memberId: string;
	readonly balance: McpMoney;
	readonly direction: BalanceDirection;
	/** A sentence to quote, e.g. "You owe THB ฿1,200.00 in this group." */
	readonly summary: string;
}

/** The whole `get_balances` payload. */
export interface BalancesView {
	readonly groupId: string;
	/** UNTRUSTED (ADR-0003). */
	readonly groupName: UntrustedText;
	/** Every amount here is in this currency — balances are never currency-mixed (§8). */
	readonly settlementCurrency: CurrencyCode;
	/**
	 * The caller's own net position, or `null` in the edge case where the key's owner
	 * has no ACTIVE member row in the group.
	 */
	readonly you: SelfBalanceView | null;
	/** Every ACTIVE member, including the settled ones. Sums to exactly zero (§8.1). */
	readonly balances: BalanceLineView[];
	/** Restated in the payload, where the model is actually reading (ADR-0008). */
	readonly _note: string;
}

/** The prohibition, in the payload itself — not only in the tool description. */
export const BALANCES_NOTE =
	'These figures are AUTHORITATIVE: computed server-side by paywithme in the ' +
	'group settlement currency, over every non-deleted transaction. Quote them as they ' +
	'stand. Never add up, convert, or adjust them yourself, and never compute an owed ' +
	'amount from `get_transaction` or a transaction list — you will get it wrong. ' +
	UNTRUSTED_NOTE;

/** Which way a signed minor-unit balance points. PURE (§8.1's sign convention). */
export function balanceDirection(minor: number): BalanceDirection {
	if (minor > 0) return 'is_owed';
	if (minor < 0) return 'owes';
	return 'settled';
}

/** The sentence the model should quote for the caller's own balance. */
function summarize(minor: number, currency: CurrencyCode): string {
	// Phrase the MAGNITUDE ("you owe THB ฿1,200.00"), never the raw negative — a
	// model asked "how much do I owe?" must not answer "−1,200".
	const magnitude = toMcpMoney(Math.abs(minor), currency).display;
	switch (balanceDirection(minor)) {
		case 'owes':
			return `You owe ${magnitude} in this group.`;
		case 'is_owed':
			return `You are owed ${magnitude} in this group.`;
		default:
			return 'You are settled up in this group: you owe nothing and are owed nothing.';
	}
}

/**
 * Project the group + its server-computed balances + its roster into the agent's
 * view. PURE: every number in `balances` arrives already computed by
 * `getGroupBalances` and is only re-shaped here (integer → decimal string).
 *
 * `members` supplies the display names and the `isYou` marks; a balance for a member
 * missing from the roster (not reachable in practice — both come from the same
 * group) degrades to an app-authored placeholder rather than dropping the line,
 * because a MISSING balance line is worse than an unnamed one.
 */
export function toBalancesView({
	group,
	members,
	balances
}: {
	group: GroupView;
	members: MemberView[];
	balances: MemberBalance[];
}): BalancesView {
	const currency = group.settlementCurrency;
	const byId = new Map(members.map((m) => [m.id, m]));

	const lines: BalanceLineView[] = balances.map((b) => {
		const member = byId.get(b.memberId);
		return {
			memberId: b.memberId,
			displayName: member?.displayName ?? untrusted('(unnamed member)', PAYWITHME_AUTHOR),
			isYou: member?.isYou ?? false,
			balance: toMcpMoney(b.balance, currency),
			direction: balanceDirection(b.balance)
		};
	});

	const self = lines.find((line) => line.isYou);

	return {
		groupId: group.id,
		groupName: group.name,
		settlementCurrency: currency,
		you: self
			? {
					memberId: self.memberId,
					balance: self.balance,
					direction: self.direction,
					summary: summarize(
						balances.find((b) => b.memberId === self.memberId)?.balance ?? 0,
						currency
					)
				}
			: null,
		balances: lines,
		_note: BALANCES_NOTE
	};
}
