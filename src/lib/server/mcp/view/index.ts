// Barrel for the MCP VIEW LAYER (ADR-0006).
//
// A projection of the same `lib/server` domain that `/api/v1` projects — and
// deliberately NOT the same projection. REST serves a developer reading an OpenAPI
// spec; MCP serves a language model reading tool descriptions, and their needs
// genuinely conflict:
//
//   | domain fact          | /api/v1 (frozen)              | MCP view (here)                     |
//   | -------------------- | ----------------------------- | ----------------------------------- |
//   | an amount            | `{ amount: 24000, currency }` | `{ amount: "240.00", …, display }`   |
//   | a group name         | `"Japan Trip"`                | `{ _untrusted, value, author }`      |
//   | who the caller is    | (nothing — no self-marker)    | `isYou` on exactly one member        |
//   | a charge's `value`   | percent OR minor units        | a `percent` XOR a money `amount`     |
//   | an owed figure       | a balances endpoint           | balances + prose + "do not re-sum"   |
//
// The `/api/v1` DTOs and their OpenAPI contract are UNCHANGED by this layer's
// existence, and must stay that way: pressure to change a REST DTO for an agent's
// benefit is the signal that this module should diverge instead (ADR-0006).
//
// Every tool in `../tools/` maps through here. No tool hand-assembles a payload —
// that is what keeps the envelope (ADR-0003) uniform, and one un-wrapped free-text
// field reopens the hole.

export {
	type UntrustedAuthor,
	type UntrustedText,
	PAYWITHME_AUTHOR,
	UNKNOWN_AUTHOR,
	UNTRUSTED_NOTE,
	untrusted,
	authorOf
} from './untrusted';

export { type McpMoney, toMcpMoney } from './money';
export { type GroupView, toGroupView } from './group';
export { type MemberView, toMemberView, selfMemberId } from './member';
export {
	type BalanceDirection,
	type BalanceLineView,
	type SelfBalanceView,
	type BalancesView,
	BALANCES_NOTE,
	balanceDirection,
	toBalancesView
} from './balance';
export {
	type PayerView,
	type ShareView,
	type ItemView,
	type ChargeView,
	type TransactionView,
	type TransactionListItemView,
	TRANSACTION_NOTE,
	LIST_TRANSACTIONS_NOTE,
	toTransactionView,
	toTransactionListItemView
} from './transaction';
export { type CurrencyView, CURRENCIES_NOTE, toCurrencyViews } from './currency';
export { type SimilarMemberView, similarlyNamedMembers } from './similar-names';
export {
	type ChangedField,
	buildEchoBack,
	buildSettleUpEchoBack,
	buildReplayEchoBack,
	buildUpdateEchoBack,
	buildDeleteEchoBack,
	buildRestoreEchoBack,
	changedFields
} from './echo';
