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
//   - ADR-0006 (view layer), as amended by ADR-0015 (member references by NAME). The
//     model sends the DISPLAY NAME it read off `list_members` — a payload the user can
//     check for themselves, which an opaque id never was — and the SERVER resolves it,
//     by the exact normalized match the active-member uniqueness index enforces. A name
//     matching no active member is a loud `validation_error`, never a guess. What that
//     does NOT settle is which real `Nan` a shorthand meant (ADR-0015, "what this does
//     not fix"), so the result still echoes the interpretation back in prose that names
//     the humans (see `../view/echo`).
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
// mechanism and its rationale (ADR-0005). Here that means:
//   - `peekIdempotentReplay` runs FIRST, on the RAW tool arguments, before any name
//     resolution: a plain retry of an already-successful call must replay that
//     success even if a referenced member was renamed or deactivated in between
//     (ADR-0015 made that resolution able to fail on a call it never failed on
//     originally, and a stale validation_error on an already-recorded transaction
//     would be wrong — see `../idempotency`'s doc comment on why this check is
//     read-only and safe to run ahead of validation that might still reject);
//   - only on NO match does the tool validate, then route the actual write through
//     `withDerivedIdempotency`, whose key is ALSO derived from the raw arguments (not
//     the resolved ones) — a create that fails validation still never enters the
//     store, so the agent's corrected retry meets a clean path;
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
import { createDbIdempotencyStore, type IdempotentResponse } from '$lib/server/api/idempotency';
import { toolError, toolSuccess } from '../errors';
import { peekIdempotentReplay, withDerivedIdempotency } from '../idempotency';
import {
	buildEchoBack,
	buildReplayEchoBack,
	memberNameSnapshot,
	selfMemberId,
	toTransactionView,
	UNTRUSTED_NOTE,
	type TransactionView
} from '../view';
import type { McpTool } from '../types';
import { GROUP_ID_PROPERTY, groupIdArg } from './args';
import { loadGroupView, loadMemberViews } from './load';
import {
	argumentErrorResult,
	MCP_TRANSACTION_ARGUMENT_FIELDS,
	McpTransactionArgumentError,
	toTransactionInput,
	validateMcpTransactionArguments,
	type McpPayerReference
} from './transaction-input';
import {
	AMOUNT_BENEFICIARY_PROPERTY,
	CHARGE_PROPERTY,
	ITEM_PROPERTY,
	MEMBER_NAME_PROPERTY,
	MONEY_PROPERTY,
	SHARE_BENEFICIARY_PROPERTY,
	SPLIT_SHAPE_ONE_OF
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
				// `splitBetween` is a flat array of NAMES (ADR-0015), so a trailing `memberId`
				// leaf has nothing to point at there; elsewhere it becomes the `memberName`
				// argument the agent actually sent.
				const leaf =
					splitMode === 'equal'
						? rest.filter((part) => part !== 'memberId')
						: rest.map((part) => (part === 'memberId' ? 'memberName' : part));
				return {
					...issue,
					path: [splitMode === 'equal' ? 'splitBetween' : 'beneficiaries', ...leaf]
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
					// The domain keys a share by id; the MCP argument holding it is a NAME.
					if (part === 'memberId') return 'memberName';
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
		// OPTIONAL: the payer's DISPLAY NAME (ADR-0015), resolved server-side. Omitted, it
		// defaults to the CALLER's own member (the `isYou` member) — an id we already hold,
		// which is why the adapter takes a payer REFERENCE rather than a bare name.
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
			'the final total and payer amount. NAMES, NOT IDS: `paidBy` and every `memberName` is a ' +
			'member DISPLAY NAME copied exactly from `list_members` — a member id here matches ' +
			'nobody and is rejected. The server resolves each name itself against the active ' +
			'members of this group, so a name it cannot match comes back as an error you can fix; ' +
			'but two members can still have similar names, so when the user says "Nan" and the ' +
			'roster holds two, ASK which one instead of picking. Every ' +
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
					...MEMBER_NAME_PROPERTY,
					description:
						'OPTIONAL display NAME of who paid, copied exactly from `list_members`. Defaults ' +
						'to YOU (your own member in this group). Never a member id.'
				},
				splitBetween: {
					type: 'array',
					minItems: 1,
					items: MEMBER_NAME_PROPERTY,
					description:
						'Member display NAMES, copied exactly from `list_members`, for an equal split. ' +
						'Required for equal mode only. Never member ids.'
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
			oneOf: SPLIT_SHAPE_ONE_OF,
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

		// ── Idempotency PEEK — before any name resolution (ADR-0015 / see `../idempotency`)
		//
		// A plain retry of an already-successful call must replay that success even if a
		// referenced member was renamed or deactivated in between — this is a READ-ONLY
		// lookup on the RAW arguments, so it can run ahead of validation that might now
		// reject the same call the roster used to accept. `null` means "no completed
		// match yet"; fall through to validate and reach the write guard below as usual.
		const idempotencyStore = createDbIdempotencyStore();
		const peeked = await peekIdempotentReplay({
			keyId: principal.keyId,
			groupId,
			toolName: TOOL_NAME,
			args: rawArgs,
			store: idempotencyStore
		});
		if (peeked) return replaySuccess(peeked);

		// The roster is what every member NAME is resolved against (ADR-0015), where the
		// `paidBy` default comes from, and where the echo-back's names come from. It
		// carries deactivated members too, so a removed person can be named as removed.
		const members = await loadMemberViews(principal, groupId);

		// Who paid. An EXPLICIT `paidBy` is a name the shared adapter resolves (one
		// resolution rule, one place); an omitted one defaults to the CALLER's own member
		// (ADR-0006: `isYou`, server-derived from the key owner) — already an id, so it is
		// passed as one. If the caller has no member row at all they cannot be the implicit
		// payer: a self-correctable validation_error rather than an opaque throw.
		const selfId = paidBy === undefined ? selfMemberId(members) : null;
		if (paidBy === undefined && selfId === null) {
			return toolError(
				'validation_error',
				'You are not a member of this group, so `paidBy` cannot default to you. ' +
					'Pass an explicit `paidBy` member name from `list_members`.',
				{ fieldErrors: { paidBy: ['Pass an active member name from `list_members`.'] } }
			);
		}
		const payer: McpPayerReference =
			paidBy === undefined
				? { kind: 'default', memberId: selfId as string }
				: { kind: 'name', memberName: paidBy };

		// Omission means Other, not the first display row (Food & Drink). Explicit ids were
		// already checked against the same list advertised in the tool's JSON Schema.
		const resolvedCategoryId = categoryId ?? DEFAULT_SPENDING_CATEGORY_ID;

		// The shared MCP adapter is the ONLY decimal-string/basis-point conversion path, and
		// the ONLY name → member-id resolution path. It reports every unresolvable name at
		// its exact nested MCP argument path, and derives the itemized total + payer amount
		// from items and ordered charges.
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
					payer,
					members
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
		// The `peekIdempotentReplay` above already ruled out a completed match on the RAW
		// arguments; everything between it and here is validation that has now succeeded,
		// and none of it has touched the ledger — which is why the guard starts HERE: a
		// create that was going to be rejected never inserts an idempotency row, so the
		// agent's corrected retry is unimpeded.
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
			store: idempotencyStore,
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
						// The names `paidBy` / `splitBetween` / beneficiary rows resolved against,
						// re-verified LOCKED inside this write's own transaction (PR #80 review — see
						// `expectedMemberNames` on `createTransaction`). The full roster snapshot,
						// not just the resolved ids: `input` no longer distinguishes a NAME-resolved
						// id from a DEFAULTED one (unlike `settle_up`, which never merged them), and
						// checking a defaulted id too only ever costs a rare, self-correctable retry —
						// never a wrong write.
						expectedMemberNames: memberNameSnapshot(members),
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

		// The ordinary path: the create ran, exactly once.
		if (replayedAfterMs === null) {
			return toolSuccess({ ...(response.body as CreatedPayload), replayed: false });
		}

		// A REPLAY: the window absorbed a retry. This is a SUCCESS — the user's intent
		// (one lunch on the ledger) holds — but it is told PLAINLY rather than hidden, so
		// the agent cannot report a second lunch that does not exist. The full wrapped
		// `recorded` view still ships (ADR-0003 holds on a replay exactly as on a create);
		// only the prose changes, and `replayed` states it machine-readably.
		return replaySuccess({ response, replayedAfterMs });
	}
};

/**
 * The REPLAY response shape, shared by the early `peekIdempotentReplay` exit and
 * the ordinary `withDerivedIdempotency` replay branch below it — the two answer
 * the same question ("this exact call already succeeded, `replayedAfterMs` ago")
 * from two different lookup points, and must render identically to the agent
 * either way.
 */
function replaySuccess({
	response,
	replayedAfterMs
}: {
	response: IdempotentResponse;
	replayedAfterMs: number;
}) {
	const payload = response.body as CreatedPayload;
	return toolSuccess({
		...payload,
		replayed: true,
		recordedAgoSeconds: Math.round(replayedAfterMs / 1000),
		echo: buildReplayEchoBack({ recordedEcho: payload.echo, replayedAfterMs })
	});
}
