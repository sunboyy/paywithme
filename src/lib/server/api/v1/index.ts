// Barrel for the `/api/v1` DTO + mapper layer (PLAN §16.4).
//
// One owned wire DTO + one pure mapper per read-side resource (group, member,
// balance, transaction list item, transaction detail), mapped from the
// `lib/server` read models and dropping UI-only / internal fields. Route handlers
// (#17–#19) import from here so an internal read-model shape can never silently
// reach the wire. See `money.ts` for the governing `{ amount, currency }` rule.

export { type Money, money } from './money';
export { type GroupDto, toGroupDto } from './group';
export { type MemberDto, toMemberDto } from './member';
export { type BalanceDto, toBalanceDto } from './balance';
export { type TransactionListItemDto, toTransactionListItemDto } from './transaction-list-item';
export {
	type TransactionDetailDto,
	type DetailPayerDto,
	type DetailShareDto,
	type DetailItemDto,
	type DetailChargeDto,
	toTransactionDetailDto
} from './transaction-detail';
