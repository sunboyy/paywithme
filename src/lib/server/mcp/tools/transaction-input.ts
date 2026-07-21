// Shared MCP-only transaction input contract (issue #44).
//
// This is deliberately separate from the internal TransactionInput Zod schema.
// Agents speak decimal strings and human percentages; the domain speaks integer
// minor units and basis points. Create/update tools supply the contextual fields
// that differ between those operations, then this adapter produces the one
// canonical TransactionInput consumed by the transaction service.

import { z } from 'zod';
import { parseAmount, type CurrencyCode } from '$lib/money';
import {
	applyCharges,
	buildTransactionSchema,
	type TransactionInput
} from '$lib/schemas/transaction';
import { percentStringToBasisPoints } from '../percentage';
import { amountArg } from './args';

const memberId = z.string().min(1, 'A member id is required. Call `list_members` first.');
const shareWeight = z
	.number({ message: 'A share weight is required.' })
	.int('Share weight must be a whole number.')
	.nonnegative('Share weight must be zero or more.')
	.safe('Share weight is out of range.');

const beneficiary = z.strictObject({
	memberId,
	// Agent vocabulary is `amount`; only the adapter calls it `rawAmount` internally.
	amount: amountArg.optional(),
	shareWeight: shareWeight.optional()
});

const item = z.strictObject({
	label: z
		.string()
		.trim()
		.min(1, 'An item label is required.')
		.max(200, 'An item label must be 200 characters or fewer.'),
	amount: amountArg,
	splitMode: z.enum(['equal', 'amount', 'share']),
	beneficiaries: z.array(beneficiary).min(1, 'List at least one beneficiary for each item.')
});

const chargeKind = z.enum(['service', 'vat', 'discount', 'tip']);
const chargeBase = z.enum(['items_subtotal', 'running_total']);
const percentCharge = z.strictObject({
	kind: chargeKind,
	mode: z.literal('percent'),
	percent: z
		.string()
		.regex(/^\d{1,3}(?:\.\d{1,2})?$/, 'Percent must be a decimal string such as "7" or "7.5".')
		.refine(
			(value) => {
				try {
					return percentStringToBasisPoints(value) <= 10_000;
				} catch {
					// Refinements are predicates: malformed/out-of-range model input must
					// become a normal Zod validation issue, never escape as a generic Error.
					return false;
				}
			},
			{
				message: 'Percent must be between "0" and "100".'
			}
		),
	base: chargeBase
});
const absoluteCharge = z.strictObject({
	kind: chargeKind,
	mode: z.literal('absolute'),
	amount: amountArg,
	base: chargeBase
});

export const mcpChargeArg = z.discriminatedUnion('mode', [percentCharge, absoluteCharge]);

/**
 * Fields shared by the create and update top-level argument objects. Exported so
 * each tool can retain one strict top-level object and add only its own metadata.
 */
export const MCP_TRANSACTION_ARGUMENT_FIELDS = {
	amount: amountArg.optional(),
	splitMode: z.enum(['equal', 'amount', 'share', 'itemized']).optional(),
	// Legacy equal-split shape. It remains the canonical equal wire representation.
	splitBetween: z
		.array(memberId)
		.min(1, 'List at least one member id to split between.')
		.optional(),
	// Rich amount/share representation. `amount` here is an exact beneficiary amount.
	beneficiaries: z.array(beneficiary).min(1, 'List at least one beneficiary.').optional(),
	items: z.array(item).min(1, 'List at least one item.').optional(),
	charges: z.array(mcpChargeArg).optional()
} as const;

type RefinementContext = Parameters<
	Parameters<ReturnType<typeof z.strictObject>['superRefine']>[0]
>[1];

/** Cross-field validation shared by schemas embedded in both write tools. */
export function validateMcpTransactionArguments(
	value: z.infer<z.ZodObject<typeof MCP_TRANSACTION_ARGUMENT_FIELDS>>,
	ctx: RefinementContext
): void {
	const mode = value.splitMode ?? 'equal';
	const issue = (path: (string | number)[], message: string) =>
		ctx.addIssue({ code: 'custom', path, message });

	if (mode === 'equal') {
		if (value.amount === undefined) issue(['amount'], 'An amount is required for an equal split.');
		if (value.splitBetween === undefined)
			issue(['splitBetween'], 'List at least one member id to split between.');
		if (value.beneficiaries !== undefined)
			issue(['beneficiaries'], 'Use `splitBetween` for an equal split.');
	} else if (mode === 'amount' || mode === 'share') {
		if (value.amount === undefined) issue(['amount'], `An amount is required for a ${mode} split.`);
		if (value.beneficiaries === undefined)
			issue(['beneficiaries'], `List the beneficiaries for a ${mode} split.`);
		if (value.splitBetween !== undefined)
			issue(['splitBetween'], `Use \`beneficiaries\` for a ${mode} split.`);
	} else {
		if (value.amount !== undefined)
			issue(
				['amount'],
				'Omit `amount` for an itemized split; the server derives it from items and charges.'
			);
		if (value.items === undefined)
			issue(['items'], 'List at least one item for an itemized split.');
		if (value.splitBetween !== undefined || value.beneficiaries !== undefined)
			issue(['beneficiaries'], 'Itemized beneficiaries belong inside each item.');
	}

	if (mode !== 'itemized' && (value.items !== undefined || value.charges !== undefined)) {
		issue(['items'], 'Items and charges are only valid when `splitMode` is `itemized`.');
	}

	const validateBeneficiaries = (
		rows: readonly z.infer<typeof beneficiary>[],
		rowMode: 'equal' | 'amount' | 'share',
		path: (string | number)[]
	) => {
		rows.forEach((row, index) => {
			if (rowMode === 'amount' && row.amount === undefined)
				issue([...path, index, 'amount'], 'An amount is required for every beneficiary.');
			if (rowMode === 'share' && row.shareWeight === undefined)
				issue([...path, index, 'shareWeight'], 'A share weight is required for every beneficiary.');
			if (rowMode !== 'amount' && row.amount !== undefined)
				issue([...path, index, 'amount'], `Do not provide an amount for a ${rowMode} split.`);
			if (rowMode !== 'share' && row.shareWeight !== undefined)
				issue(
					[...path, index, 'shareWeight'],
					`Do not provide a share weight for a ${rowMode} split.`
				);
		});
		if (rowMode === 'share' && rows.reduce((sum, row) => sum + (row.shareWeight ?? 0), 0) <= 0) {
			issue(path, 'Share weights must add up to more than zero.');
		}
	};

	if ((mode === 'amount' || mode === 'share') && value.beneficiaries !== undefined) {
		validateBeneficiaries(value.beneficiaries, mode, ['beneficiaries']);
	}
	value.items?.forEach((row, index) =>
		validateBeneficiaries(row.beneficiaries, row.splitMode, ['items', index, 'beneficiaries'])
	);
}

/** Standalone schema used by adapter tests and available to other MCP callers. */
export const mcpTransactionArguments = z
	.strictObject(MCP_TRANSACTION_ARGUMENT_FIELDS)
	.superRefine(validateMcpTransactionArguments);

export type McpTransactionArguments = z.infer<typeof mcpTransactionArguments>;

export interface McpTransactionContext {
	readonly type: 'spending' | 'transfer';
	readonly title: string;
	/** Editable real-world `created_at` day; never the immutable `occurred_at`. */
	readonly date: string;
	readonly categoryId: string;
	/** v1 MCP writes are settlement-currency-only, at exchange rate 1. */
	readonly currency: CurrencyCode;
	readonly payerId: string;
	readonly memberIds?: readonly string[];
}

/** Error whose paths deliberately use MCP argument names (ADR-0009). */
export class McpTransactionArgumentError extends Error {
	constructor(readonly issues: readonly { path: readonly (string | number)[]; message: string }[]) {
		super(issues.map((entry) => `${entry.path.join('.')}: ${entry.message}`).join('; '));
		this.name = 'McpTransactionArgumentError';
	}
}

function parseMcpAmount(value: string, currency: CurrencyCode, path: (string | number)[]): number {
	try {
		return parseAmount(value, currency);
	} catch (error) {
		throw new McpTransactionArgumentError([
			{ path, message: error instanceof Error ? error.message : 'Amount could not be parsed.' }
		]);
	}
}

/** Map the agent-friendly contract exactly into the canonical domain input. */
export function toTransactionInput(
	rawArguments: unknown,
	context: McpTransactionContext
): TransactionInput {
	const parsed = mcpTransactionArguments.safeParse(rawArguments);
	if (!parsed.success) {
		throw new McpTransactionArgumentError(
			parsed.error.issues.map((entry) => ({
				path: entry.path.map((part) => (typeof part === 'number' ? part : String(part))),
				message: entry.message
			}))
		);
	}
	const args = parsed.data;
	const splitMode = args.splitMode ?? 'equal';
	if (context.memberIds !== undefined) {
		const knownMembers = new Set(context.memberIds);
		const membershipIssues: { path: (string | number)[]; message: string }[] = [];
		const checkMember = (id: string, path: (string | number)[]) => {
			if (!knownMembers.has(id)) {
				membershipIssues.push({ path, message: 'That member is not part of this group.' });
			}
		};
		checkMember(context.payerId, ['paidBy']);
		if (splitMode === 'equal') {
			args.splitBetween!.forEach((id, index) => checkMember(id, ['splitBetween', index]));
		} else if (splitMode === 'amount' || splitMode === 'share') {
			args.beneficiaries!.forEach((row, index) =>
				checkMember(row.memberId, ['beneficiaries', index, 'memberId'])
			);
		} else {
			args.items!.forEach((row, itemIndex) =>
				row.beneficiaries.forEach((beneficiaryRow, beneficiaryIndex) =>
					checkMember(beneficiaryRow.memberId, [
						'items',
						itemIndex,
						'beneficiaries',
						beneficiaryIndex,
						'memberId'
					])
				)
			);
		}
		if (membershipIssues.length > 0) throw new McpTransactionArgumentError(membershipIssues);
	}

	const items = (args.items ?? []).map((row, itemIndex) => ({
		label: row.label,
		amount: parseMcpAmount(row.amount, context.currency, ['items', itemIndex, 'amount']),
		splitMode: row.splitMode,
		beneficiaries: row.beneficiaries.map((beneficiaryRow, beneficiaryIndex) => ({
			memberId: beneficiaryRow.memberId,
			...(row.splitMode === 'amount'
				? {
						rawAmount: parseMcpAmount(beneficiaryRow.amount!, context.currency, [
							'items',
							itemIndex,
							'beneficiaries',
							beneficiaryIndex,
							'amount'
						])
					}
				: {}),
			...(row.splitMode === 'share' ? { shareWeight: beneficiaryRow.shareWeight! } : {})
		}))
	}));

	const charges = (args.charges ?? []).map((charge, sortOrder) => ({
		kind: charge.kind,
		mode: charge.mode,
		value:
			charge.mode === 'percent'
				? percentStringToBasisPoints(charge.percent)
				: parseMcpAmount(charge.amount, context.currency, ['charges', sortOrder, 'amount']),
		base: charge.base,
		sortOrder
	}));

	const amountTotal =
		splitMode === 'itemized'
			? applyCharges(
					items.reduce((sum, row) => sum + row.amount, 0),
					charges
				).amountTotal
			: parseMcpAmount(args.amount!, context.currency, ['amount']);

	const beneficiaries =
		splitMode === 'equal'
			? args.splitBetween!.map((memberId) => ({ memberId }))
			: splitMode === 'itemized'
				? []
				: args.beneficiaries!.map((row, index) => ({
						memberId: row.memberId,
						...(splitMode === 'amount'
							? {
									rawAmount: parseMcpAmount(row.amount!, context.currency, [
										'beneficiaries',
										index,
										'amount'
									])
								}
							: {}),
						...(splitMode === 'share' ? { shareWeight: row.shareWeight! } : {})
					}));

	const candidate = {
		type: context.type,
		title: context.title,
		date: context.date,
		categoryId: context.categoryId,
		amountTotal,
		currency: context.currency,
		exchangeRate: '1',
		amountTotalSettlement: amountTotal,
		splitMode,
		payers: [{ memberId: context.payerId, amountPaid: amountTotal }],
		beneficiaries,
		items,
		charges
	};

	const validated = buildTransactionSchema({
		settlementCurrency: context.currency,
		memberIds: context.memberIds
	}).safeParse(candidate);
	if (!validated.success) {
		const remapPath = (path: PropertyKey[]): (string | number)[] => {
			const normalized = path.map((part) => (typeof part === 'number' ? part : String(part)));
			const first = normalized[0];
			if (first === 'payers') return ['paidBy'];
			if (first === 'beneficiaries') {
				normalized[0] = splitMode === 'equal' ? 'splitBetween' : 'beneficiaries';
			}
			if (
				first === 'amountTotal' ||
				first === 'amountTotalSettlement' ||
				first === 'exchangeRate'
			) {
				return [splitMode === 'itemized' ? 'charges' : 'amount'];
			}
			return normalized.map((part) => {
				if (part === 'rawAmount') return 'amount';
				if (part !== 'value') return part;
				const chargeIndex =
					normalized[0] === 'charges' && typeof normalized[1] === 'number'
						? normalized[1]
						: undefined;
				return chargeIndex !== undefined && args.charges?.[chargeIndex]?.mode === 'absolute'
					? 'amount'
					: 'percent';
			});
		};
		throw new McpTransactionArgumentError(
			validated.error.issues.map((entry) => ({
				path: remapPath(entry.path),
				message: entry.message
			}))
		);
	}
	return validated.data;
}
