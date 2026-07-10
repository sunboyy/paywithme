// `v1` TransactionListItem DTO + mapper (PLAN §16.4, §7.6).
//
// Maps the internal `TransactionListItem` read model to the owned wire DTO. The
// row carries TWO amounts in DIFFERENT currencies (§7.6): the ORIGINAL total in
// the entry currency and the canonical total in the group's settlement currency.
// Per the money-on-wire rule (§16.4, see `money.ts`) each collapses from a flat
// `amount` + sibling `currency` pair into a self-describing `{ amount, currency }`
// object, so neither amount can be read against the wrong currency:
//   - `amountTotal` + `currency`            → `amount`           (entry currency)
//   - `amountTotalSettlement` + `settlementCurrency` → `settlementAmount` (settlement)
// `isForeign` is kept (it's genuine resource data — whether the two currencies
// differ), as are the category fields; nothing here is UI-only.

import type { TransactionListItem } from '$lib/server/transactions';
import { money, type Money } from './money';

/** A transaction list row as served by `/api/v1` (PLAN §16.4). */
export interface TransactionListItemDto {
	readonly id: string;
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
	/** The real-world date (§7.1 `created_at`), ISO string — the display/sort date. */
	readonly createdAt: string;
}

/**
 * Map an internal {@link TransactionListItem} to its wire
 * {@link TransactionListItemDto}. PURE: object → object, no DB/IO. Nests both
 * amounts as self-describing money (entry vs settlement currency).
 */
export function toTransactionListItemDto(item: TransactionListItem): TransactionListItemDto {
	return {
		id: item.id,
		type: item.type,
		title: item.title,
		categoryId: item.categoryId,
		categoryName: item.categoryName,
		categoryIcon: item.categoryIcon,
		amount: money(item.amountTotal, item.currency),
		settlementAmount: money(item.amountTotalSettlement, item.settlementCurrency),
		isForeign: item.isForeign,
		createdAt: item.createdAt
	};
}
