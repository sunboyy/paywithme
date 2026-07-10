// `v1` TransactionDetail DTO + mapper (PLAN §16.4, §7.1/§7.2/§7.6/§9).
//
// Maps the internal `TransactionDetail` read model to the owned wire DTO. The
// key §16.4 transform:
//   - DROP `input` — the reconstructed `TransactionInput` edit-form SEED. It is a
//     UI-only re-edit convenience, the single largest internal field, and exactly
//     the kind of thing the owned-DTO seam exists to keep off the wire.
// Every monetary value nests as self-describing money (§16.4, see `money.ts`),
// each in its correct currency:
//   - the txn total   `amountTotal`/`currency`            → `amount`           (ENTRY)
//   - the settlement total `amountTotalSettlement`/`settlementCurrency` → `settlementAmount`
//   - each payer's `amountPaid`  → ENTRY currency (payers pay in the entry currency)
//   - each share's `amountOwed`  → SETTLEMENT currency (§8 source of truth)
//   - each item's `amount`       → ENTRY currency; its shares → SETTLEMENT currency
// A charge's `value` is deliberately NOT wrapped: in `percent` mode it is a
// percentage, not an amount, so it stays a bare scalar (see `money.ts`).
// The view data (payers, shares, items, charges, `deletedAt`) is kept — a
// soft-deleted txn is still served (marked via `deletedAt`) so it can be shown.

import type { CurrencyCode } from '$lib/money';
import type { TransactionDetail } from '$lib/server/transactions';
import { money, type Money } from './money';

/** One resolved per-member settlement share, on the wire (§8). */
export interface DetailShareDto {
	readonly memberId: string;
	/** Resolved owed, as SETTLEMENT-currency money. */
	readonly amountOwed: Money;
}

/** One payer line, on the wire (§7.6). */
export interface DetailPayerDto {
	readonly memberId: string;
	/** Paid, as ENTRY-currency money. */
	readonly amountPaid: Money;
}

/** One itemized line, on the wire (§7.2). */
export interface DetailItemDto {
	readonly label: string;
	/** Item amount, as ENTRY-currency money. */
	readonly amount: Money;
	readonly splitMode: 'equal' | 'amount' | 'share';
	readonly shares: DetailShareDto[];
}

/** One charge line, on the wire (§7.2.2). `value` is NOT money — see module note. */
export interface DetailChargeDto {
	readonly kind: 'service' | 'vat' | 'discount' | 'tip';
	readonly mode: 'percent' | 'absolute';
	/** Percentage (percent mode) OR entry-currency minor units (absolute mode). */
	readonly value: number;
	readonly base: 'items_subtotal' | 'running_total';
	readonly sortOrder: number;
}

/** The full transaction detail as served by `/api/v1` (PLAN §16.4). `input` dropped. */
export interface TransactionDetailDto {
	readonly id: string;
	readonly groupId: string;
	readonly type: 'spending' | 'transfer';
	readonly title: string;
	readonly categoryId: string;
	readonly categoryName: string;
	readonly categoryIcon: string;
	/** The ORIGINAL total in the ENTRY currency (§7.6). */
	readonly amount: Money;
	/** The canonical total in the group's SETTLEMENT currency (§8). */
	readonly settlementAmount: Money;
	/** Whether the entry currency differs from the settlement currency (§7.6). */
	readonly isForeign: boolean;
	readonly splitMode: 'equal' | 'amount' | 'share' | 'itemized';
	/** The real-world date (§7.1 `created_at`), ISO string. */
	readonly createdAt: string;
	/** Soft-delete time (§9), ISO string, or null when live. */
	readonly deletedAt: string | null;
	readonly payers: DetailPayerDto[];
	readonly shares: DetailShareDto[];
	readonly items: DetailItemDto[];
	readonly charges: DetailChargeDto[];
}

/**
 * Map an internal {@link TransactionDetail} to its wire {@link TransactionDetailDto}.
 * PURE: object → object, no DB/IO. Drops `input` and nests every monetary value
 * as self-describing money in its correct currency (entry vs settlement).
 */
export function toTransactionDetailDto(detail: TransactionDetail): TransactionDetailDto {
	const entry: CurrencyCode = detail.currency;
	const settlement: CurrencyCode = detail.settlementCurrency;

	return {
		id: detail.id,
		groupId: detail.groupId,
		type: detail.type,
		title: detail.title,
		categoryId: detail.categoryId,
		categoryName: detail.categoryName,
		categoryIcon: detail.categoryIcon,
		amount: money(detail.amountTotal, entry),
		settlementAmount: money(detail.amountTotalSettlement, settlement),
		isForeign: detail.isForeign,
		splitMode: detail.splitMode,
		createdAt: detail.createdAt,
		deletedAt: detail.deletedAt,
		payers: detail.payers.map((p) => ({
			memberId: p.memberId,
			amountPaid: money(p.amountPaid, entry)
		})),
		shares: detail.shares.map((s) => ({
			memberId: s.memberId,
			amountOwed: money(s.amountOwed, settlement)
		})),
		items: detail.items.map((item) => ({
			label: item.label,
			amount: money(item.amount, entry),
			splitMode: item.splitMode,
			shares: item.shares.map((s) => ({
				memberId: s.memberId,
				amountOwed: money(s.amountOwed, settlement)
			}))
		})),
		charges: detail.charges.map((c) => ({
			kind: c.kind,
			mode: c.mode,
			value: c.value,
			base: c.base,
			sortOrder: c.sortOrder
		}))
	};
}
