// Shared MCP-only transaction input contract (issue #44).
//
// This is deliberately separate from the internal TransactionInput Zod schema.
// Agents speak decimal strings, human percentages and member NAMES (ADR-0015); the
// domain speaks integer minor units, basis points and member IDS. Create/update tools
// supply the contextual fields that differ between those operations, then this adapter
// produces the one canonical TransactionInput consumed by the transaction service —
// and it is the single place where a name becomes an id.

import { z } from 'zod';
import { parseAmount, type SeededCurrencyCode } from '$lib/money';
import {
	applyCharges,
	buildTransactionSchema,
	type TransactionInput
} from '$lib/schemas/transaction';
import { percentStringToBasisPoints } from '../percentage';
import { toolError } from '../errors';
import { memberNameIssueMessage, resolveMemberByName, type MemberView } from '../view';
import { amountArg } from './args';

const memberName = z
	.string()
	.min(1, 'A member display name is required. Call `list_members` first.');
const shareWeight = z
	.number({ message: 'A share weight is required.' })
	.int('Share weight must be a whole number.')
	.nonnegative('Share weight must be zero or more.')
	.safe('Share weight is out of range.');

const beneficiary = z.strictObject({
	memberName,
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
		.array(memberName)
		.min(1, 'List at least one member name to split between.')
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
			issue(['splitBetween'], 'List at least one member name to split between.');
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

/**
 * Who paid, as the tool knows them BEFORE resolution (ADR-0015).
 *
 * `paidBy` is an agent-supplied NAME, but an OMITTED `paidBy` resolves to an id the
 * server already holds and the agent never typed — the caller's own member on a
 * create, the recorded payer on an update. Carrying that difference in the type is
 * what lets ALL name resolution stay in this one adapter: a tool never has to
 * normalize-and-match on its own just because its default is already an id.
 */
export type McpPayerReference =
	/** An explicit `paidBy` name, still to be resolved here. */
	| { readonly kind: 'name'; readonly memberName: string }
	/** The tool's own default — already a member id, so only checked, never matched. */
	| { readonly kind: 'default'; readonly memberId: string };

export interface McpTransactionContext {
	readonly type: 'spending' | 'transfer';
	readonly title: string;
	/** Editable real-world `created_at` day; never the immutable `occurred_at`. */
	readonly date: string;
	readonly categoryId: string;
	/** v1 MCP writes are settlement-currency-only, at exchange rate 1. */
	readonly currency: SeededCurrencyCode;
	readonly payer: McpPayerReference;
	/**
	 * The group's FULL roster, deactivated members included. Required, because a name
	 * cannot be resolved without one — and the deactivated rows are what let a removed
	 * member be reported as removed rather than as a name nobody has (§6.3).
	 */
	readonly members: readonly MemberView[];
}

/** Error whose paths deliberately use MCP argument names (ADR-0009). */
export class McpTransactionArgumentError extends Error {
	constructor(readonly issues: readonly { path: readonly (string | number)[]; message: string }[]) {
		super(issues.map((entry) => `${entry.path.join('.')}: ${entry.message}`).join('; '));
		this.name = 'McpTransactionArgumentError';
	}
}

/**
 * Turn an {@link McpTransactionArgumentError} into the `validation_error` tool result
 * both write tools return for it. Each issue is reported at its exact nested argument
 * path AND (when they differ) at its top-level root — the nested path is what an agent
 * corrects, the root is the field contract the tools' JSON Schema advertises.
 */
export function argumentErrorResult(error: McpTransactionArgumentError) {
	const fieldErrors: Record<string, string[]> = {};
	for (const issue of error.issues) {
		const field = issue.path.join('.') || 'arguments';
		(fieldErrors[field] ??= []).push(issue.message);
		const root = typeof issue.path[0] === 'string' ? issue.path[0] : undefined;
		if (root !== undefined && root !== field) (fieldErrors[root] ??= []).push(issue.message);
	}
	return toolError('validation_error', error.message, { fieldErrors });
}

function parseMcpAmount(
	value: string,
	currency: SeededCurrencyCode,
	path: (string | number)[]
): number {
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

	// ── NAME → ID, once, here (ADR-0015) ───────────────────────────────────────
	// This is the ONLY place an MCP write turns a person's name into a member id. The
	// service layer downstream still speaks ids, and the resolution rule (exact match
	// on the normalized display name, active members only) must be one rule: three
	// tools each matching names their own way would be three subtly different notions
	// of "the same person" deciding whose money moves.
	//
	// Every miss is COLLECTED rather than thrown at, so one round trip tells the agent
	// about every unresolvable name at once — the same batching the old id-membership
	// check used, and the reason a corrected retry needs one attempt, not four.
	const activeMemberIds = context.members.filter((member) => member.isActive).map((m) => m.id);
	const resolutionIssues: { path: (string | number)[]; message: string }[] = [];
	const resolve = (name: string, path: (string | number)[]): string => {
		const match = resolveMemberByName(context.members, name);
		if (match.kind === 'resolved') return match.id;
		resolutionIssues.push({ path, message: memberNameIssueMessage(name, match) });
		// Unused: a non-empty `resolutionIssues` throws before any of these ids is read.
		return '';
	};

	const payerId =
		context.payer.kind === 'name'
			? resolve(context.payer.memberName, ['paidBy'])
			: context.payer.memberId;
	// A DEFAULTED payer was never matched from a name, but it can still be a member the
	// group has since removed (the caller's own deactivated row on a create, the
	// recorded payer on an update). Naming it under `paidBy` keeps that the agent's
	// self-correctable "pass someone else" rather than an opaque failure downstream.
	if (context.payer.kind === 'default' && !activeMemberIds.includes(payerId)) {
		resolutionIssues.push({
			path: ['paidBy'],
			message:
				'The member who would pay by default is no longer an active member of this group. ' +
				'Pass an explicit `paidBy` name from `list_members`.'
		});
	}

	// Only the fields belonging to this split mode are present — the cross-field
	// refinement above already rejected the others — so all three map safely.
	const splitBetweenIds = (args.splitBetween ?? []).map((name, index) =>
		resolve(name, ['splitBetween', index])
	);
	const beneficiaryIds = (args.beneficiaries ?? []).map((row, index) =>
		resolve(row.memberName, ['beneficiaries', index, 'memberName'])
	);
	const itemBeneficiaryIds = (args.items ?? []).map((row, itemIndex) =>
		row.beneficiaries.map((beneficiaryRow, beneficiaryIndex) =>
			resolve(beneficiaryRow.memberName, [
				'items',
				itemIndex,
				'beneficiaries',
				beneficiaryIndex,
				'memberName'
			])
		)
	);
	if (resolutionIssues.length > 0) throw new McpTransactionArgumentError(resolutionIssues);

	const items = (args.items ?? []).map((row, itemIndex) => ({
		label: row.label,
		amount: parseMcpAmount(row.amount, context.currency, ['items', itemIndex, 'amount']),
		splitMode: row.splitMode,
		beneficiaries: row.beneficiaries.map((beneficiaryRow, beneficiaryIndex) => ({
			memberId: itemBeneficiaryIds[itemIndex][beneficiaryIndex],
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
			? splitBetweenIds.map((memberId) => ({ memberId }))
			: splitMode === 'itemized'
				? []
				: args.beneficiaries!.map((row, index) => ({
						memberId: beneficiaryIds[index],
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
		payers: [{ memberId: payerId, amountPaid: amountTotal }],
		beneficiaries,
		items,
		charges
	};

	const validated = buildTransactionSchema({
		settlementCurrency: context.currency,
		memberIds: activeMemberIds
	}).safeParse(candidate);
	if (!validated.success) {
		const remapPath = (path: PropertyKey[]): (string | number)[] => {
			const normalized = path.map((part) => (typeof part === 'number' ? part : String(part)));
			const first = normalized[0];
			if (first === 'payers') return ['paidBy'];
			if (first === 'beneficiaries') {
				normalized[0] = splitMode === 'equal' ? 'splitBetween' : 'beneficiaries';
				// `splitBetween` is a flat array of NAMES (ADR-0015): it has no leaf field to
				// point a `memberId` issue at, so the index itself is the correctable position.
				if (splitMode === 'equal' && normalized[normalized.length - 1] === 'memberId') {
					normalized.pop();
				}
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
				// The domain keys a share by id; the MCP argument holding it is a NAME.
				if (part === 'memberId') return 'memberName';
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
