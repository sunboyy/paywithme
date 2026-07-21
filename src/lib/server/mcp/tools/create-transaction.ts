// `create_transaction` — the Connector's FIRST WRITE tool (issue #31).
//
// "Log 240 baht for lunch, split with Nan" must record ฿240.00, not ฿2.40, and
// must name the humans back so a wrong pick is caught in the transcript. Two ADRs
// carry the whole weight of this tool:
//
//   - ADR-0004 (agent-facing money). The model NEVER does exponent arithmetic. The
//     `amount` argument is a DECIMAL STRING ("240", "240.00", "1234.5"); the server
//     runs the existing `parseAmount(amount, settlementCurrency)` to get minor units
//     via that currency's own exponent. More decimal places than the currency allows
//     is a HARD ERROR (`"240.005"` in THB → rejected), never a silent round.
//   - ADR-0006 (view layer). IDs ONLY, never names — the model matches "Nan" against
//     `list_members` ITSELF, visibly; and the result echoes the interpretation back
//     in prose that names the humans (see `../view/echo`).
//
// ── FX is DEFERRED — a deliberate v1 boundary (read before you widen the scope) ─
// An assistant has no exchange-rate source, and the internal transaction schema
// requires a rate + a settlement total for a FOREIGN entry currency. So v1 records
// ONLY in the group's SETTLEMENT currency: `currency` is optional and defaults to it,
// and a `currency` that does NOT equal the group's settlement currency is a
// `validation_error` naming the settlement currency — NOT an attempt at FX math. This
// keeps `parseAmount` driven by a real currency code (so the per-currency exponent
// matrix is exercised — a THB group for the THB case, a JPY group for the JPY case)
// with exchangeRate fixed at '1' and amountTotalSettlement == amountTotal.
//
// ── What this tool does NOT do ───────────────────────────────────────────────
//   - Scope + rate limit: the dispatcher (`tools.ts` → `dispatchToolCall`) ALREADY
//     denies a read key with `forbidden_scope` and consumes the WRITE rate-limit
//     class before `run` is entered. We only DECLARE `scope: 'write'` /
//     `rateLimitClass: 'write'`; re-checking here would be dead, drifting code.
//   - Audit: `createTransaction` writes the `audit_log` row (carrying `viaKey`
//     provenance from `auditVia(principal)`) in the SAME DB transaction as the
//     insert (§12.1). We never write audit ourselves. A REPLAY (below) re-runs
//     nothing, so it writes no transaction AND no audit row (§16.6).
//
// ── Idempotency: a SERVER-DERIVED key over a ~60s sliding window (#33) ───────
// The agent cannot send an `Idempotency-Key` (`tools/call` carries only model-
// generated arguments), so the server derives one and routes the create through the
// existing `withIdempotency` store — see `../idempotency`, which owns the whole
// mechanism and its rationale (ADR-0005). Here that means only:
//   - the key is derived from the RAW tool arguments, AFTER validation, so a rejected
//     create never enters the store — the agent's corrected retry meets a clean path;
//   - a content-identical retry within the window REPLAYS, and the replay is SURFACED
//     in the echo-back ("already recorded 3 seconds ago"), never hidden;
//   - the same expense AFTER the window is a NEW transaction — two ฿60 coffees in a
//     day is normal, and swallowing the second would under-bill the user.
//
// The legacy shape remains a single-payer equal spending. Rich calls add exact-amount,
// weighted, and itemized splits without changing that established wire contract.

import { z } from 'zod';
import { categoriesFor } from '$lib/categories';
import {
	createTransaction,
	getTransactionDetail,
	TransactionValidationError
} from '$lib/server/transactions';
import { auditVia } from '$lib/server/api/provenance';
import { createDbIdempotencyStore } from '$lib/server/api/idempotency';
import { toolError, toolSuccess } from '../errors';
import { withDerivedIdempotency } from '../idempotency';
import {
	buildEchoBack,
	buildReplayEchoBack,
	selfMemberId,
	toTransactionView,
	UNTRUSTED_NOTE,
	type TransactionView
} from '../view';
import type { McpTool } from '../types';
import { GROUP_ID_PROPERTY, groupIdArg } from './args';
import { loadGroupView, loadMemberViews } from './load';
import {
	MCP_TRANSACTION_ARGUMENT_FIELDS,
	McpTransactionArgumentError,
	toTransactionInput,
	validateMcpTransactionArguments
} from './transaction-input';
import {
	AMOUNT_BENEFICIARIES_PROPERTY,
	AMOUNT_BENEFICIARY_PROPERTY,
	CHARGE_PROPERTY,
	forbidProperties,
	ITEM_PROPERTY,
	MONEY_PROPERTY,
	SHARE_BENEFICIARIES_PROPERTY,
	SHARE_BENEFICIARY_PROPERTY
} from './transaction-json-schema';

/** The wire name — shared by the definition and the derived idempotency key (#33). */
const TOOL_NAME = 'create_transaction';

/** The category contract advertised to the model and enforced at the tool boundary. */
const SPENDING_CATEGORY_IDS = categoriesFor('spending').map((category) => category.id);

/** A genuinely generic fallback; the previous first-row fallback was Food & Drink. */
const DEFAULT_SPENDING_CATEGORY_ID = 'spending-other';

/** Translate a late service validation failure back to this tool's wire vocabulary. */
function remapTransactionValidationError(
	error: TransactionValidationError,
	splitMode: 'equal' | 'amount' | 'share' | 'itemized',
	charges: readonly { mode: 'percent' | 'absolute' }[] | undefined
) {
	return new TransactionValidationError(
		error.issues.map((issue) => {
			const [first, ...rest] = issue.path;
			if (first === 'payers') return { ...issue, path: ['paidBy'] };
			if (first === 'beneficiaries') {
				return {
					...issue,
					path: [splitMode === 'equal' ? 'splitBetween' : 'beneficiaries', ...rest]
				};
			}
			if (
				first === 'amountTotal' ||
				first === 'amountTotalSettlement' ||
				first === 'exchangeRate'
			) {
				return { ...issue, path: [splitMode === 'itemized' ? 'charges' : 'amount'] };
			}
			return {
				...issue,
				path: issue.path.map((part, index) => {
					if (part === 'rawAmount') return 'amount';
					if (part !== 'value') return part;
					const chargeIndex = issue.path[0] === 'charges' ? issue.path[index - 1] : undefined;
					return typeof chargeIndex === 'number' && charges?.[chargeIndex]?.mode === 'absolute'
						? 'amount'
						: 'percent';
				})
			};
		}),
		error.message
	);
}

function argumentErrorResult(error: McpTransactionArgumentError) {
	const fieldErrors: Record<string, string[]> = {};
	for (const issue of error.issues) {
		const field = issue.path.join('.') || 'arguments';
		(fieldErrors[field] ??= []).push(issue.message);
		// Preserve the original top-level field contract (`splitBetween`, `amount`, …)
		// while also providing the exact rich nested path an agent can correct.
		const root = typeof issue.path[0] === 'string' ? issue.path[0] : undefined;
		if (root !== undefined && root !== field) (fieldErrors[root] ??= []).push(issue.message);
	}
	return toolError('validation_error', error.message, { fieldErrors });
}

/**
 * The payload a successful create produces, and the one a REPLAY reads back out of
 * the idempotency store. Every field is JSON-scalar (the view layer emits dates as
 * strings), so the `jsonb` round-trip is lossless — a replay reconstructs the same
 * `recorded` view, wrapped exactly as the original was (ADR-0003).
 */
interface CreatedPayload {
	recorded: TransactionView;
	echo: string;
	_note: string;
}

const createTransactionArgs = z
	.strictObject({
		groupId: groupIdArg,
		title: z
			.string()
			.min(1, 'A title is required.')
			.max(200, 'Title must be 200 characters or fewer.')
			.regex(/\S/, 'A title is required.'),
		...MCP_TRANSACTION_ARGUMENT_FIELDS,
		// OPTIONAL: FX is deferred, so this defaults to (and must equal) the group's
		// settlement currency. See the header.
		currency: z.string().min(1).optional(),
		// OPTIONAL: defaults to the CALLER's own member (the `isYou` member).
		paidBy: z.string().min(1).optional(),
		// OPTIONAL: defaults to the genuinely generic Other category. The enum is also
		// advertised in JSON Schema, so the model can choose without guessing an id.
		categoryId: z
			.string()
			.refine((id) => SPENDING_CATEGORY_IDS.includes(id), 'Choose a valid spending category id.')
			.optional()
	})
	.superRefine(validateMcpTransactionArguments);

export const createTransactionTool: McpTool<z.infer<typeof createTransactionArgs>> = {
	scope: 'write',
	rateLimitClass: 'write',
	args: createTransactionArgs,
	definition: {
		name: TOOL_NAME,
		title: 'Record a spending',
		description:
			'Record a shared spending with one payer. Omit `splitMode` for the legacy equal split: ' +
			'pass `amount` and `splitBetween`. For an exact amount or weighted split, pass ' +
			'`splitMode`, the total `amount`, and `beneficiaries` with an `amount` decimal string ' +
			'or integer `shareWeight`. For `itemized`, omit the top-level amount and pass receipt ' +
			'`items`; each item has its own equal/amount/share beneficiaries. Optional ordered ' +
			'`charges` support service, VAT, discount, and tip as either a human `percent` string ' +
			'or an absolute money `amount`; ARRAY ORDER IS APPLICATION ORDER, and the server derives ' +
			'the final total and payer amount. IDS ONLY, NEVER NAMES: `paidBy` and every beneficiary ' +
			'id must come from `list_members`; match people yourself and show your reasoning. Every ' +
			'money amount is a DECIMAL STRING exactly as the user said it — the server does currency ' +
			'math, so never multiply by 100 or convert exponents. The ' +
			"amount must be in the group's settlement currency (logging a foreign currency via the " +
			'assistant is not supported yet). Defaults: `paidBy` is you, `currency` is the group ' +
			'settlement currency, and ' +
			'`categoryId` defaults to Other. Choose another category from the enum advertised in ' +
			'the input schema. The result echoes back what was recorded, naming the ' +
			'people involved, so you and the user can confirm the interpretation. If a call seems ' +
			'to have failed, an identical retry within about a minute is de-duplicated rather than ' +
			'recorded twice, and the result will say so — but after that, an identical call records ' +
			'a SECOND transaction (two identical coffees in a day are real), so do not use a repeat ' +
			'call to check whether something was saved. Use `list_transactions` for that.',
		inputSchema: {
			type: 'object',
			properties: {
				groupId: GROUP_ID_PROPERTY,
				title: {
					type: 'string',
					minLength: 1,
					maxLength: 200,
					pattern: '\\S',
					description: 'A short human title for the spending, e.g. "Lunch". Required.'
				},
				amount: {
					...MONEY_PROPERTY,
					description:
						'Total amount. Required for equal, amount, and share splits; OMIT for itemized ' +
						'because the server derives the total from items and ordered charges.'
				},
				splitMode: {
					type: 'string',
					enum: ['equal', 'amount', 'share', 'itemized'],
					description: 'Omit for backward-compatible equal splitting.'
				},
				currency: {
					type: 'string',
					minLength: 1,
					description:
						"OPTIONAL ISO-4217 code. Must equal the group's settlement currency (call " +
						'`get_group` to see it); omit to default to it. Foreign-currency logging via the ' +
						'assistant is not supported yet.'
				},
				paidBy: {
					type: 'string',
					minLength: 1,
					description:
						'OPTIONAL member id of who paid, from `list_members`. Defaults to YOU (your own ' +
						'member in this group). Never a name.'
				},
				splitBetween: {
					type: 'array',
					minItems: 1,
					items: { type: 'string', minLength: 1 },
					description: 'Member ids for an equal split. Required for equal mode only.'
				},
				beneficiaries: {
					type: 'array',
					minItems: 1,
					items: {
						oneOf: [AMOUNT_BENEFICIARY_PROPERTY, SHARE_BENEFICIARY_PROPERTY]
					},
					description: 'Raw beneficiary inputs for top-level amount/share modes.'
				},
				items: {
					type: 'array',
					minItems: 1,
					items: ITEM_PROPERTY,
					description: 'Receipt items. Required for itemized mode.'
				},
				charges: {
					type: 'array',
					items: CHARGE_PROPERTY,
					description: 'Optional itemized charges in application order.'
				},
				categoryId: {
					type: 'string',
					enum: SPENDING_CATEGORY_IDS,
					description: `OPTIONAL spending category id. Defaults to ${DEFAULT_SPENDING_CATEGORY_ID} (Other) if omitted.`
				}
			},
			required: ['groupId', 'title'],
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
			title: 'Record a spending',
			// This tool WRITES: it is not read-only, and (belt-and-braces) is not
			// destructive — it appends a transaction, it never deletes or overwrites one.
			readOnlyHint: false,
			destructiveHint: false,
			// FALSE — deliberately, even though #33 landed the server-derived window.
			//
			// The MCP annotation means "calling this repeatedly with the same arguments has
			// no ADDITIONAL effect", with no time qualifier. What ADR-0005 actually gives is
			// a BOUNDED ~60s dedup window, and the boundary is not an implementation detail
			// we would like to hide: past it, an identical call records a SECOND transaction
			// ON PURPOSE, because two ฿60 coffees in a day are a real thing a user does.
			//
			// So `true` would be an overclaim in the one direction that costs money: it tells
			// the model repeat calls are free, which is exactly wrong at t+61s. `false` errs
			// toward the model treating a retry as consequential — which it is. The window is
			// a SAFETY NET under a careless retry, not a licence to retry; the description and
			// the replay echo-back carry the nuance that this boolean cannot.
			idempotentHint: false,
			openWorldHint: false
		}
	},
	run: async ({ principal }, rawArgs) => {
		const {
			groupId,
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
		// Access-checked load of the group (and its settlement currency). `loadGroupView`
		// centralizes the conflated `not_found` (absent / deleted / not-yours → ONE outcome,
		// no existence oracle, §16.5) so this write path inherits it by construction rather
		// than re-implementing the `getGroupForUser` → `GroupAccessError` dance.
		const { settlementCurrency } = await loadGroupView(principal, groupId);

		// FX DEFERRAL (see header): only the settlement currency is loggable in v1. A
		// mismatching `currency` is a self-correctable validation_error, not FX math.
		if (currency !== undefined && currency !== settlementCurrency) {
			return toolError(
				'validation_error',
				`This group settles in ${settlementCurrency}. Logging in a different currency ` +
					`(${currency}) via the assistant is not supported yet — state the amount in ` +
					`${settlementCurrency}.`,
				{ fieldErrors: { currency: [`Currency must be ${settlementCurrency} for this group.`] } }
			);
		}

		// The roster resolves member ids to (untrusted) names + `isYou`, both for the
		// `paidBy` default and for the echo-back's names.
		const members = await loadMemberViews(principal, groupId);

		// Default the payer to the CALLER's own member (ADR-0006: `isYou`, server-derived
		// from the key owner). If the caller has no active member row they cannot be the
		// implicit payer — a self-correctable validation_error rather than an opaque throw.
		const payerId = paidBy ?? selfMemberId(members);
		if (payerId === null) {
			return toolError(
				'validation_error',
				'You are not an active member of this group, so `paidBy` cannot default to you. ' +
					'Pass an explicit `paidBy` member id from `list_members`.',
				{ fieldErrors: { paidBy: ['Pass an active member id from `list_members`.'] } }
			);
		}

		const activeMemberIds = members.filter((member) => member.isActive).map((member) => member.id);

		// Omission means Other, not the first display row (Food & Drink). Explicit ids were
		// already checked against the same list advertised in the tool's JSON Schema.
		const resolvedCategoryId = categoryId ?? DEFAULT_SPENDING_CATEGORY_ID;

		// The shared MCP adapter is the ONLY decimal-string/basis-point conversion path.
		// It also validates every active member at the exact nested MCP argument path and
		// derives itemized total + payer amount from items and ordered charges.
		let input;
		try {
			input = toTransactionInput(
				{ amount, splitMode, splitBetween, beneficiaries, items, charges },
				{
					type: 'spending',
					title,
					date: new Date().toISOString().slice(0, 10),
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

		// Keep an explicit alias for the echo's minor-unit restatement. In itemized mode
		// this value was computed by `applyCharges`; it never came from a client total.
		const minor = input.amountTotal;

		// ── The WRITE, guarded by the server-derived ~60s window (ADR-0005, #33) ──
		//
		// Everything above this line is validation, and none of it has touched the ledger
		// — which is why the guard starts HERE: a create that was going to be rejected
		// never inserts an idempotency row, so the agent's corrected retry is unimpeded.
		//
		// The key is derived from the RAW arguments the model sent, not the resolved ones:
		// it must answer "did the model already send me exactly this?", and resolving the
		// defaults first would make an explicit `paidBy` collide with an omitted one.
		// ADR-0005 is explicit that this protects against an IDENTICAL retry only — an
		// agent that re-phrases the title on retry gets two rows, and nothing can fix that.
		//
		// `fn` runs AT MOST ONCE per (calling key + group + tool + args + window): the
		// create, its audit row (§12.1), and the read-back that shapes the response all
		// live inside it, so a replay re-runs NONE of them and writes no audit row (§16.6).
		const { response, replayedAfterMs } = await withDerivedIdempotency({
			keyId: principal.keyId,
			groupId,
			toolName: TOOL_NAME,
			// The COMPLETE parsed raw argument object is fingerprinted. Every nested item,
			// weight, exact amount, charge, and its ARRAY POSITION therefore distinguishes
			// intents; no rich input can collide with a simpler transaction.
			args: rawArgs,
			store: createDbIdempotencyStore(),
			fn: async () => {
				// Create + AUDIT in one DB transaction (§12.1). `auditVia(principal)` carries the
				// key's provenance (`viaKey`) into the audit row — audit comes for free, we never
				// write it ourselves.
				let txnId: string;
				try {
					txnId = await createTransaction({
						userId: principal.userId,
						groupId,
						input,
						settlementCurrency,
						via: auditVia(principal)
					});
				} catch (error) {
					// Keep the shared service authoritative, but never leak its internal form-field
					// names (`payers`, `beneficiaries`, `amountTotal`) to an MCP caller.
					if (error instanceof TransactionValidationError) {
						throw remapTransactionValidationError(error, input.splitMode, charges);
					}
					throw error;
				}

				// Re-read the persisted detail and project BOTH echo forms (see `../view/echo`):
				//   - `recorded`: the structured view, every name wrapped + attributed (ADR-0003);
				//   - `echo`:     the prose restatement that NAMES the humans (ADR-0006 legibility).
				const detail = await getTransactionDetail({ userId: principal.userId, groupId, txnId });
				const recorded = toTransactionView({ detail, members, principal });
				const payload: CreatedPayload = {
					recorded,
					echo: buildEchoBack({ view: recorded, minorUnits: minor }),
					// The prose inlines member display names for legibility — so the result also
					// carries the untrusted-note, marking any name/title in the payload as DATA,
					// and every such name is ALSO present wrapped inside `recorded` (ADR-0003).
					_note: UNTRUSTED_NOTE
				};
				// `status` is the REST store's shape (§16.6); MCP has no HTTP status for a tool
				// result, so it is a fixed 200 and only `body` is ever read back on this path.
				return { status: 200, body: payload };
			}
		});

		const payload = response.body as CreatedPayload;

		// The ordinary path: the create ran, exactly once.
		if (replayedAfterMs === null) {
			return toolSuccess({ ...payload, replayed: false });
		}

		// A REPLAY: the window absorbed a retry. This is a SUCCESS — the user's intent
		// (one lunch on the ledger) holds — but it is told PLAINLY rather than hidden, so
		// the agent cannot report a second lunch that does not exist. The full wrapped
		// `recorded` view still ships (ADR-0003 holds on a replay exactly as on a create);
		// only the prose changes, and `replayed` states it machine-readably.
		return toolSuccess({
			...payload,
			replayed: true,
			recordedAgoSeconds: Math.round(replayedAfterMs / 1000),
			echo: buildReplayEchoBack({ recordedEcho: payload.echo, replayedAfterMs })
		});
	}
};
