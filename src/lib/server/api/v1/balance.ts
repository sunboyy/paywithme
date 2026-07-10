// `v1` Balance DTO + mapper (PLAN §16.4, §8.1).
//
// Maps the internal `MemberBalance` read model (`{ memberId, balance }`, in
// SETTLEMENT-currency minor units) to the owned wire DTO. The internal model
// carries a bare integer with no currency — but the money-on-wire rule (§16.4)
// requires every amount to be self-describing, so the mapper takes the group's
// settlement currency and nests the balance as `{ amount, currency }`. See
// `money.ts` for why we nest rather than emit a sibling `currency` scalar.

import type { CurrencyCode } from '$lib/money';
import type { MemberBalance } from '$lib/transactions/balances';
import { money, type Money } from './money';

/** One member's net balance as served by `/api/v1` (PLAN §16.4, §8.1). */
export interface BalanceDto {
	readonly memberId: string;
	/**
	 * Net balance as self-describing money: Σ paid − Σ owed in the settlement
	 * currency's minor units. Positive → creditor, negative → debtor, 0 → square.
	 */
	readonly balance: Money;
}

/**
 * Map an internal {@link MemberBalance} to its wire {@link BalanceDto}. PURE:
 * object → object, no DB/IO. `settlementCurrency` is the group's settlement
 * currency — the code the internal `balance` integer is denominated in — passed
 * in so the emitted amount is self-describing (the internal model omits it).
 */
export function toBalanceDto(balance: MemberBalance, settlementCurrency: CurrencyCode): BalanceDto {
	return {
		memberId: balance.memberId,
		balance: money(balance.balance, settlementCurrency)
	};
}
