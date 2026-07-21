// `update_transaction` — *"no, that lunch was 950"*, fixed in the conversation it was
// recorded in (issue #35).
//
// A mistake made in conversation should be fixable in conversation. This is the first
// of the three REVERSIBILITY tools, and they are not a convenience feature: ADR-0003
// accepts that a prompt-injected write CAN land, and pays for that acceptance with
// "an injected write is visible, attributable to a specific key, and undoable". Undo
// is the currency that claim is denominated in. Without these three tools the ADR's
// risk appetite is a hope; with them it is a mechanism.
//
// ── A REPLACEMENT, not a patch — and what an omitted argument means ──────────
// §16.4 pins the REST verb: "PUT (not PATCH) for update — the body is the COMPLETE
// `TransactionInput` (full replacement, the honest idempotent verb)". This tool is a
// full replacement too: `title`, `amount` and `splitBetween` are REQUIRED, and what
// lands is what you sent.
//
// But it diverges from REST on the DEFAULTS, deliberately (ADR-0006 exists for exactly
// this kind of divergence), and the divergence is a money control:
//
//   - `paidBy` defaults to THE EXISTING PAYER — NOT to the caller, the way it does on
//     `create_transaction`. On a create, "whoever is asking paid" is the overwhelmingly
//     likely truth. On an EDIT it is a guess about a fact that is already recorded, and
//     the failure is silent and expensive: the user says "that dinner was 950, not 240",
//     the model sends title + amount + splitBetween, and Bob's ฿950 dinner becomes the
//     caller's. Preserving the recorded payer means an omitted `paidBy` cannot move
//     money between people; only an EXPLICIT one can, and the echo names who it landed on.
//   - `categoryId` likewise defaults to the EXISTING category, and the `type`
//     (spending / transfer) is carried over rather than accepted at all: a settle-up
//     silently becoming a spending would rewrite what happened, not correct it.
//   - The §7.1 real-world DATE is carried over from the existing row. The shared schema
//     defaults an absent `date` to TODAY — correct on a create, data loss on an edit
//     (fixing last Tuesday's dinner would drag it to today, changing the list order and
//     the day the user reads). It is re-sent verbatim from `detail.input`.
//
// ── The SHAPES this tool refuses to touch, and why that is not timidity ──────
// The v1 write shape is a single-payer EQUAL-SPLIT in the settlement currency (the same
// shape `create_transaction` writes). A transaction that is itemized, percentage-split,
// multi-payer, or entered in a FOREIGN currency cannot be expressed in these arguments —
// so replacing one through this tool would FLATTEN it: the itemized breakdown, the
// per-item shares, the service charge, the exchange rate, all gone, none of it in the
// arguments the model sent, none of it recoverable.
//
// That is the ONE write in this issue that is NOT reversible. `restore_transaction`
// undoes a delete; NOTHING undoes an overwrite (§16.6 is explicit: last-write-wins, no
// version column, no `If-Match`, and the audit row's metadata carries only a before /
// after of the key fields — enough to SEE the clobber, not enough to rebuild the items).
// So a shape this tool cannot faithfully re-express is refused with a `validation_error`
// that says where to do it instead. Refusing is the reversibility guarantee holding; a
// silent flatten would be it quietly failing.
//
// ── What this tool does NOT do ───────────────────────────────────────────────
//   - Scope + rate limit: the dispatcher (`tools.ts` → `dispatchToolCall`) ALREADY
//     denies a read key with `forbidden_scope` and consumes the WRITE rate-limit class
//     before `run` is entered. We only DECLARE `scope: 'write'` / `rateLimitClass: 'write'`.
//   - Audit: `updateTransaction` writes the `edit` audit row (carrying `viaKey`
//     provenance from `auditVia(principal)`) in the SAME DB transaction as the update
//     (§12.1). We never write audit ourselves.
//   - Idempotency: NO derived window, unlike the create path — see `idempotentHint`.

import { z } from 'zod';
import { getTransactionDetail, updateTransaction } from '$lib/server/transactions';
import { auditVia } from '$lib/server/api/provenance';
import { toolError, toolSuccess } from '../errors';
import {
	buildUpdateEchoBack,
	changedFields,
	toTransactionView,
	UNTRUSTED_NOTE,
	type TransactionView
} from '../view';
import type { McpTool } from '../types';
import { GROUP_ID_PROPERTY, groupIdArg, TXN_ID_PROPERTY, txnIdArg } from './args';
import { loadGroupView, loadMemberViews } from './load';
import {
	AMOUNT_BENEFICIARIES_PROPERTY,
	CHARGE_PROPERTY,
	forbidProperties,
	ITEM_PROPERTY,
	MEMBER_ID_PROPERTY,
	MONEY_PROPERTY,
	SHARE_BENEFICIARIES_PROPERTY
} from './transaction-json-schema';
import {
	MCP_TRANSACTION_ARGUMENT_FIELDS,
	McpTransactionArgumentError,
	toTransactionInput,
	validateMcpTransactionArguments
} from './transaction-input';

/** The wire name. */
const TOOL_NAME = 'update_transaction';

const updateTransactionArgs = z
	.strictObject({
		groupId: groupIdArg,
		txnId: txnIdArg,
		// REQUIRED: this is a REPLACEMENT (§16.4's PUT), not a merge — an unstated title
		// would be a patch, and a patch is the verb §16.4 rejected.
		title: z
			.string()
			.min(1, 'A title is required.')
			.max(200, 'Title must be 200 characters or fewer.')
			.regex(/\S/, 'A title is required.'),
		// The ADR-0004 decimal-string gate, shared with every other write tool (`./args`).
		...MCP_TRANSACTION_ARGUMENT_FIELDS,
		// OPTIONAL: FX is deferred (as on `create_transaction`), so this defaults to (and
		// must equal) the group's settlement currency.
		currency: z.string().min(1).optional(),
		// OPTIONAL: defaults to THE EXISTING PAYER — never the caller. See the header.
		paidBy: z.string().min(1).optional(),
		// OPTIONAL: defaults to the transaction's EXISTING category.
		categoryId: z.string().min(1).optional()
	})
	.superRefine(validateMcpTransactionArguments);

function argumentErrorResult(error: McpTransactionArgumentError) {
	const fieldErrors: Record<string, string[]> = {};
	for (const issue of error.issues) {
		const field = issue.path.join('.') || 'arguments';
		(fieldErrors[field] ??= []).push(issue.message);
		const root = typeof issue.path[0] === 'string' ? issue.path[0] : undefined;
		if (root !== undefined && root !== field) (fieldErrors[root] ??= []).push(issue.message);
	}
	return toolError('validation_error', error.message, { fieldErrors });
}

export const updateTransactionTool: McpTool<z.infer<typeof updateTransactionArgs>> = {
	scope: 'write',
	rateLimitClass: 'write',
	args: updateTransactionArgs,
	definition: {
		name: TOOL_NAME,
		title: 'Correct a transaction',
		description:
			'Correct a transaction that is already recorded — the amount was wrong, the title ' +
			'was wrong, the split was wrong. CALL `get_transaction` FIRST and read what is ' +
			'currently recorded: copy its `editable` object, unwrap authored `title.value` and ' +
			'item `label.value` fields, then send the COMPLETE equal, amount, share, or itemized ' +
			'split shape. This REPLACES rather than patches the transaction — omitting an item, ' +
			'beneficiary, or charge REMOVES it. Itemized total is derived by the server. ' +
			'IDS ONLY, NEVER NAMES: `txnId`, `paidBy` and every beneficiary id ' +
			'come from `list_transactions` / `list_members`; match the people the user named to ' +
			'ids YOURSELF and show your reasoning. STATE THE AMOUNT EXACTLY AS THE USER SAID IT ' +
			'("950", "950.00") as a decimal string — the server does the currency math, so never ' +
			'multiply by 100 or convert exponents. Defaults: `paidBy` and `categoryId` KEEP what ' +
			'the transaction already has (omit them unless the user is changing who paid or what ' +
			'kind of expense it is), and the transaction keeps its original date and type. A ' +
			'transaction with several payers or one entered in a foreign currency is refused. The result ' +
			'echoes back BOTH what the transaction was and what it now is, naming the people ' +
			'involved — read it out, because an edit overwrites the old values and nothing ' +
			'restores them. To remove a transaction entirely use `delete_transaction` instead.',
		inputSchema: {
			type: 'object',
			properties: {
				groupId: GROUP_ID_PROPERTY,
				txnId: { ...TXN_ID_PROPERTY, minLength: 1 },
				title: {
					type: 'string',
					minLength: 1,
					maxLength: 200,
					pattern: '\\S',
					description:
						'The title the transaction should now have, e.g. "Dinner". REQUIRED — pass the ' +
						'existing title unchanged if the user is not changing it.'
				},
				amount: {
					...MONEY_PROPERTY,
					description:
						'The amount the transaction should now be, as a DECIMAL STRING, stated exactly ' +
						'as the user said it: "950", "950.00". No currency symbol, no thousands ' +
						"separators, no negative sign. The server converts to the currency's minor " +
						'units — do NOT do that math yourself. REQUIRED — pass the existing amount ' +
						'unchanged if the user is not changing it.'
				},
				currency: {
					type: 'string',
					minLength: 1,
					description:
						"OPTIONAL ISO-4217 code. Must equal the group's settlement currency; omit to " +
						'default to it. Changing a transaction into another currency via the assistant ' +
						'is not supported.'
				},
				paidBy: {
					type: 'string',
					minLength: 1,
					description:
						'OPTIONAL member id of who paid, from `list_members`. Defaults to WHOEVER IS ' +
						'ALREADY RECORDED as having paid — omit it unless the user is explicitly ' +
						'changing who paid. Never a name.'
				},
				splitBetween: {
					type: 'array',
					minItems: 1,
					items: MEMBER_ID_PROPERTY,
					description:
						'REQUIRED array of member ids (from `list_members`) the cost should now be split ' +
						'equally between. This REPLACES the existing split — pass the full list, ' +
						'including everyone who should stay on it. Never names.'
				},
				splitMode: {
					type: 'string',
					enum: ['equal', 'amount', 'share', 'itemized'],
					description: 'Complete replacement split shape; omit only for legacy equal mode.'
				},
				beneficiaries: {
					type: 'array',
					minItems: 1,
					items: {
						oneOf: [AMOUNT_BENEFICIARIES_PROPERTY.items, SHARE_BENEFICIARIES_PROPERTY.items]
					}
				},
				items: { type: 'array', minItems: 1, items: ITEM_PROPERTY },
				charges: { type: 'array', items: CHARGE_PROPERTY },
				categoryId: {
					type: 'string',
					minLength: 1,
					description:
						"OPTIONAL category id. Defaults to the transaction's existing category — omit it " +
						'unless the user is changing the kind of expense.'
				}
			},
			required: ['groupId', 'txnId', 'title'],
			oneOf: [
				{
					properties: { splitMode: { enum: ['equal'] } },
					required: ['amount', 'splitBetween'],
					...forbidProperties('beneficiaries', 'items', 'charges')
				},
				{
					properties: {
						splitMode: { const: 'amount' },
						beneficiaries: AMOUNT_BENEFICIARIES_PROPERTY
					},
					required: ['splitMode', 'amount', 'beneficiaries'],
					...forbidProperties('splitBetween', 'items', 'charges')
				},
				{
					properties: {
						splitMode: { const: 'share' },
						beneficiaries: SHARE_BENEFICIARIES_PROPERTY
					},
					required: ['splitMode', 'amount', 'beneficiaries'],
					...forbidProperties('splitBetween', 'items', 'charges')
				},
				{
					properties: { splitMode: { const: 'itemized' } },
					required: ['splitMode', 'items'],
					...forbidProperties('amount', 'splitBetween', 'beneficiaries')
				}
			],
			additionalProperties: false
		},
		annotations: {
			title: 'Correct a transaction',
			readOnlyHint: false,
			// FALSE — and this is the line worth pausing on, because an edit DOES overwrite
			// data irrecoverably (see the header), which sounds like the definition of
			// destructive. `destructiveHint` is not a severity dial: MCP defines it as
			// "may perform destructive UPDATES", i.e. the tool can REMOVE something the user
			// has, and the approval UI gates it harder. `delete_transaction` removes a
			// transaction from the ledger; this one corrects a transaction that stays. If
			// both claimed `true` the flag would stop distinguishing them, and the ONE tool
			// in this Connector that takes something away would gate exactly like the tool
			// that fixes a typo. The exclusivity is what makes the flag mean anything —
			// which is why the refusal to flatten an itemized bill lives in `run` (a hard
			// error, not a hint the user can click through) rather than in this boolean.
			destructiveHint: false,
			// TRUE — and, unlike `create_transaction`, honestly so. That tool says false
			// because a repeat call at t+61s records a SECOND transaction on purpose (two
			// ฿60 coffees in a day are real), so `true` would tell the model retries are
			// free in the one direction that costs money.
			//
			// A replacement has no such boundary. Sending the same replacement twice leaves
			// the ledger in the SAME state as sending it once — that is what "full
			// replacement" means, and §16.6 says so outright: "PUT/DELETE/restore … These
			// ops are already idempotent". So no derived idempotency window guards this
			// tool: there is nothing for one to protect (ADR-0005's window exists to stop a
			// retry from DUPLICATING a create; a duplicate replacement is a no-op), and
			// adding one would only make a legitimate correct-it-again-two-seconds-later
			// call fail as a phantom "replay".
			//
			// The honest caveat: a repeat DOES bump `updated_at` and DOES write a second
			// `edit` audit row (§12.1 gates a state-transition check on delete/restore, not
			// on edit). Neither is an effect on the ledger — the audit trail recording that
			// the tool was called twice is the trail doing its job — and `idempotentHint`
			// speaks about what the call does to the user's data, which is: nothing new.
			idempotentHint: true,
			openWorldHint: false
		}
	},
	run: async ({ principal }, rawArgs) => {
		const {
			groupId,
			txnId,
			title,
			amount,
			splitMode,
			splitBetween,
			beneficiaries,
			items,
			charges,
			currency,
			paidBy,
			categoryId
		} = rawArgs;
		// Access-checked load of the group (and its settlement currency — GROUP CONTEXT,
		// never the payload). `loadGroupView` centralizes the conflated `not_found`
		// (absent / deleted / not-yours → ONE outcome, no existence oracle, §16.5).
		const { settlementCurrency } = await loadGroupView(principal, groupId);

		// FX DEFERRAL (as on `create_transaction`): only the settlement currency is
		// writable in v1. A mismatching `currency` is a self-correctable validation_error.
		if (currency !== undefined && currency !== settlementCurrency) {
			return toolError(
				'validation_error',
				`This group settles in ${settlementCurrency}. Changing a transaction into a ` +
					`different currency (${currency}) via the assistant is not supported — state the ` +
					`amount in ${settlementCurrency}.`
			);
		}

		const members = await loadMemberViews(principal, groupId);

		// The BEFORE state. Access-checked AND group-scoped: an absent id, an id in
		// another group, and an id the caller cannot see all throw
		// `TransactionNotFoundError` → the SAME conflated `not_found` as an unseeable
		// group (§16.5). It is also the source of every default below, and of the echo's
		// "it WAS" half — read BEFORE the update, because after it the old values are gone.
		const before = await getTransactionDetail({ userId: principal.userId, groupId, txnId });
		const beforeView = toTransactionView({ detail: before, members, principal });

		// A soft-deleted txn cannot be edited (the service throws `TransactionDeletedError`
		// → `validation_error`, mapped in `../errors`). Caught here first only to say which
		// tool fixes it — the agent's next move is `restore_transaction`, then this again.
		if (before.deletedAt !== null) {
			return toolError(
				'validation_error',
				'That transaction is deleted, so it cannot be corrected. Call `restore_transaction` ' +
					'with this id first, then correct it.'
			);
		}

		// ── The SHAPE GATE (see the header) ────────────────────────────────────────
		// These arguments can express exactly one shape: a single-payer, equal-split,
		// settlement-currency transaction. Anything else would be FLATTENED — silently, and
		// with no restore to undo it. Refuse, and say where the edit can actually be made.
		const unsupported =
			before.payers.length !== 1
				? 'it has more than one payer'
				: before.isForeign
					? `it was entered in ${before.currency}, not the group's settlement currency`
					: null;
		if (unsupported !== null) {
			return toolError(
				'validation_error',
				`This transaction cannot be corrected through the assistant because ${unsupported}. ` +
					'Correcting it here would replace it with a simple equal split and lose that detail ' +
					'irreversibly. Edit it in the paywithme app instead. (You can still use ' +
					'`delete_transaction` on it, which is reversible.)'
			);
		}

		// The DEFAULTS that keep an omitted argument from moving money (see the header):
		// the payer and the category come from the EXISTING row, never from the caller.
		// `before.payers.length === 1` is guaranteed by the shape gate above.
		const payerId = paidBy ?? before.payers[0].memberId;
		const resolvedCategoryId = categoryId ?? before.categoryId;

		const activeMemberIds = members.filter((member) => member.isActive).map((member) => member.id);
		let input;
		try {
			input = toTransactionInput(
				{ amount, splitMode, splitBetween, beneficiaries, items, charges },
				{
					type: before.type,
					title,
					date: before.input.date,
					categoryId: resolvedCategoryId,
					currency: settlementCurrency,
					payerId,
					memberIds: activeMemberIds
				}
			);
		} catch (error) {
			if (error instanceof McpTransactionArgumentError) return argumentErrorResult(error);
			throw error;
		}

		// Update + AUDIT in one DB transaction (§12.1). `auditVia(principal)` carries the
		// key's `viaKey` provenance into the `edit` audit row — audit comes for free.
		await updateTransaction({
			userId: principal.userId,
			groupId,
			txnId,
			input,
			settlementCurrency,
			via: auditVia(principal)
		});

		// Re-read the PERSISTED result rather than describing what we asked for: the echo's
		// job is to state what the ledger now HOLDS (a re-resolved split lands here, not in
		// our `input`), and the diff is computed between two views of real rows.
		const after = await getTransactionDetail({ userId: principal.userId, groupId, txnId });
		const afterView = toTransactionView({ detail: after, members, principal });
		const changed = changedFields({ before: beforeView, after: afterView });

		return toolSuccess({
			// BOTH structured views ship, each fully wrapped (ADR-0003): the prose inlines
			// names and titles from the before AND the after state, and every one of them must
			// also be present as an untrusted envelope. `replaced` is the only remaining
			// machine-readable record of what the edit overwrote.
			replaced: beforeView satisfies TransactionView,
			recorded: afterView satisfies TransactionView,
			// The same list the prose speaks, machine-readably — the two cannot disagree.
			changed,
			echo: buildUpdateEchoBack({
				before: beforeView,
				after: afterView,
				// BOTH halves speak the PERSISTED settlement figure — the one §8 reads and the one
				// the decimal beside it is rendered from. Using our own `minor` for the "now" half
				// would describe what we ASKED for while the "was" half describes the ledger, so a
				// service that stored something else would be reported as the request rather than
				// as the truth. The shape gate rules FX out, so the two are equal today; reading
				// the row keeps the sentence honest anyway.
				beforeMinorUnits: before.amountTotalSettlement,
				afterMinorUnits: after.amountTotalSettlement,
				changed
			}),
			// The prose inlines member display names and both titles for legibility — so the
			// result carries the untrusted-note, marking any name/title in the payload as
			// DATA, and every one it inlines is ALSO present wrapped above (ADR-0003).
			_note: UNTRUSTED_NOTE
		});
	}
};
