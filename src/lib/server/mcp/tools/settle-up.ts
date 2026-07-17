// `settle_up` — *"Settle up with Nan"*, recorded against the RIGHT Nan (issue #34).
//
// A thin façade over `createTransaction`, exactly as its REST sibling is (PLAN §16.4:
// "a dedicated sugar endpoint … a thin façade that builds the single-payer /
// single-beneficiary Transfer (currency = settlement at rate 1, category 'Debt
// settlement') and delegates to `createTransaction`. NO NEW DOMAIN LOGIC."). There is
// no `settleUp` service to call and there must not be one: a settle-up IS a transfer,
// and the day it stops going through the ordinary create path is the day it stops
// obeying the ordinary rules (§7.6 validation, §12.1 audit, the balances that §8.4
// expects to shrink).
//
// ── The two failure modes that meet here ────────────────────────────────────
// The server already rejects a HALLUCINATED member id. What it cannot reject is a
// VALID write against the WRONG REAL PERSON: an agent matching "Nan" against a roster
// holding `Nan Suphaporn` and `Nanthawat P.` can pick either, and both pass every
// guard while moving one human's money to another. And `from` — the caller's OWN
// member id — was not obtainable at all before `isYou` existed (ADR-0006), so the
// agent's only recourse was to guess it from a display name: the wrong-payer failure,
// guaranteed rather than occasional.
//
// ADR-0006's answer is LEGIBILITY, NOT PREVENTION, in three parts, all of them here:
//   - `from` DEFAULTS to the caller's own member (`isYou`, server-derived from the
//     key's owner — the one identity in the request the model cannot influence). The
//     overwhelmingly common settle-up therefore cannot pick the wrong payer at all,
//     because the agent never picks it. An explicit `from` is still accepted:
//     recording that A paid B on someone else's behalf is a real flow.
//   - IDS ONLY in the schema. No server-side fuzzy matching in the money path — the
//     agent matches "Nan" to an id ITSELF, visibly, in the transcript, where the user
//     can see the reasoning.
//   - The ECHO-BACK NAMES THE PAYEE IN FULL ("Recorded settle-up: you → Nan
//     Suphaporn, THB 1200.00"), and where the roster holds someone else who could
//     have been meant, it says who (`../view/similar-names` — a post-write, purely
//     presentational check that never touches the payee decision). A wrong pick is
//     read in plain language on the spot, instead of surfacing weeks later.
//
// ── Everything else it inherits rather than re-implements ────────────────────
//   - SCOPE + RATE LIMIT: the dispatcher denies a read key (`forbidden_scope`) and
//     consumes the WRITE class before `run` is entered. We only DECLARE them.
//   - AUDIT: `createTransaction` writes the `audit_log` row (with `viaKey` provenance
//     from `auditVia(principal)`) in the SAME DB transaction as the insert (§12.1).
//   - IDEMPOTENCY: the same server-derived ~60s sliding window as the create path
//     (`../idempotency`, ADR-0005). `toolName` is part of the derived key, so a
//     `settle_up` can never dedup against a `create_transaction`.
//   - MONEY: `amount` is a DECIMAL STRING and the server does the exponent math
//     (ADR-0004). No `currency` argument exists — unlike `create_transaction`, this
//     is not an FX deferral but a definition: a settlement is denominated in the
//     group's settlement currency at rate 1 (§16.4), so a currency choice would be a
//     way to get it wrong, not a feature. §16.4's REST body has no currency either.

import { z } from 'zod';
import { parseAmount } from '$lib/money';
import { createTransaction, getTransactionDetail } from '$lib/server/transactions';
import { auditVia } from '$lib/server/api/provenance';
import { createDbIdempotencyStore } from '$lib/server/api/idempotency';
import { toolError, toolSuccess } from '../errors';
import { withDerivedIdempotency } from '../idempotency';
import {
	buildReplayEchoBack,
	buildSettleUpEchoBack,
	selfMemberId,
	similarlyNamedMembers,
	toTransactionView,
	UNTRUSTED_NOTE,
	type SimilarMemberView,
	type TransactionView
} from '../view';
import type { McpTool } from '../types';
import { amountArg, GROUP_ID_PROPERTY, groupIdArg } from './args';
import { loadGroupView, loadMemberViews } from './load';

/** The wire name — shared by the definition and the derived idempotency key (#33). */
const TOOL_NAME = 'settle_up';

/**
 * The transfer category every settle-up records under (PLAN §8.4 / §16.4) — the same
 * constant the REST sibling holds. Deliberately not shared with it: `/api/v1` and this
 * surface diverge on purpose (ADR-0006), and a settle-up's category is a fact about
 * the DOMAIN (`$lib/categories`), not a fact either surface owns.
 */
const DEBT_SETTLEMENT_CATEGORY = 'transfer-debt-settlement';

/** The title every settle-up transfer carries (§8.4's prefill, and REST's). */
const DEBT_SETTLEMENT_TITLE = 'Debt settlement';

/**
 * The payload a successful settle-up produces, and the one a REPLAY reads back out of
 * the idempotency store. Every field is JSON-scalar, so the `jsonb` round-trip is
 * lossless and a replay reconstructs the same wrapped views (ADR-0003).
 */
interface SettledPayload {
	recorded: TransactionView;
	echo: string;
	/**
	 * The ADR-0006 "other Nan"s — members NOT involved in this settle-up whose names
	 * could be confused with the payee's. Usually `[]`.
	 *
	 * This field is what makes the echo's prose LEGAL under ADR-0003: the prose inlines
	 * these display names as bare substrings, and a bare member-authored string is the
	 * exact shape the ADR calls dangerous. `recorded` cannot carry them — a settle-up's
	 * payers/shares only cover `from` and `to`, so a third member appears nowhere in it
	 * — so they are carried here instead, wrapped and attributed, and `_note` marks
	 * every name in the payload as data. Same discipline, different field.
	 */
	similarNames: SimilarMemberView[];
	_note: string;
}

const settleUpArgs = z.strictObject({
	groupId: groupIdArg,
	// REQUIRED: the payee's member id (never a name, ADR-0006).
	to: z.string().min(1, 'A payee member id is required. Call `list_members` to find it.'),
	// OPTIONAL: defaults to the CALLER's own member — the `isYou` member (ADR-0006).
	from: z.string().min(1).optional(),
	// The ADR-0004 decimal-string gate, shared with every other write tool (`./args`).
	amount: amountArg
});

export const settleUpTool: McpTool<z.infer<typeof settleUpArgs>> = {
	scope: 'write',
	rateLimitClass: 'write',
	args: settleUpArgs,
	definition: {
		name: TOOL_NAME,
		title: 'Record a settle-up payment',
		description:
			'Record a settle-up: one member paying another back to clear what they owe (a ' +
			'transfer, categorised as a debt settlement). Use this when the user says they PAID ' +
			'someone back — not for a shared expense, which is `create_transaction`. IDS ONLY, ' +
			'NEVER NAMES: `to` (and `from`, if you pass it) must be member ids from ' +
			'`list_members` — match the person the user named ("settle up with Nan") to an id ' +
			'YOURSELF and show your reasoning, because two members can have similar names and ' +
			'this tool does no name matching. `from` DEFAULTS TO YOU (your own member in this ' +
			'group, the one `list_members` marks `isYou`) — omit it unless the user is recording ' +
			'a payment SOMEONE ELSE made. STATE THE AMOUNT EXACTLY AS THE USER SAID IT ("1200", ' +
			'"1200.00") as a decimal string in the group\'s settlement currency; the server does ' +
			'the currency math, so never multiply by 100 or convert exponents. The result echoes ' +
			'back what was recorded, naming the people in full, so you and the user can confirm ' +
			'the interpretation — read it out; if it names the wrong person, say so rather than ' +
			'recording a correction silently. If a call seems to have failed, an identical retry ' +
			'within about a minute is de-duplicated rather than recorded twice, and the result ' +
			'will say so — but after that it records a SECOND payment, so do not use a repeat ' +
			'call to check whether something was saved. Use `list_transactions` for that.',
		inputSchema: {
			type: 'object',
			properties: {
				groupId: GROUP_ID_PROPERTY,
				to: {
					type: 'string',
					description:
						'REQUIRED member id of who was PAID (the creditor), from `list_members`. Match ' +
						'the person the user named to an id yourself. Never a name.'
				},
				from: {
					type: 'string',
					description:
						'OPTIONAL member id of who PAID (the debtor), from `list_members`. Defaults to ' +
						'YOU (your own member in this group). Pass it only to record a payment someone ' +
						'else made. Never a name.'
				},
				amount: {
					type: 'string',
					description:
						'The amount paid, as a DECIMAL STRING, stated exactly as the user said it: ' +
						'"1200", "1200.00". No currency symbol, no thousands separators, no negative ' +
						"sign. It is in the group's settlement currency (call `get_group` to see it) — " +
						"the server converts to that currency's minor units, so do NOT do that math " +
						'yourself.'
				}
			},
			required: ['groupId', 'to', 'amount'],
			additionalProperties: false
		},
		annotations: {
			title: 'Record a settle-up payment',
			// This tool WRITES, and (belt-and-braces) is not destructive: it APPENDS a
			// transfer, it never deletes or overwrites one.
			readOnlyHint: false,
			destructiveHint: false,
			// FALSE, for the same reason `create_transaction` says false: the MCP annotation
			// claims repeat calls have no ADDITIONAL effect, with no time qualifier, and what
			// ADR-0005 gives is a BOUNDED ~60s window. Past it an identical call records a
			// SECOND payment on purpose — paying someone back twice in a day is a real thing.
			// `true` would tell the model retries are free in the one direction that costs
			// money.
			idempotentHint: false,
			openWorldHint: false
		}
	},
	run: async ({ principal }, { groupId, to, from, amount }) => {
		// Access-checked load of the group (and its settlement currency — GROUP CONTEXT,
		// never taken from the payload). `loadGroupView` centralizes the conflated
		// `not_found` (absent / deleted / not-yours → ONE outcome, no existence oracle,
		// §16.5), so this write path inherits it by construction.
		const { settlementCurrency } = await loadGroupView(principal, groupId);

		// The roster resolves member ids to (untrusted) names + `isYou`: it is where the
		// `from` default comes from, where the echo's names come from, and where the
		// "other Nan" check looks.
		const members = await loadMemberViews(principal, groupId);

		// ── The DEFAULT PAYER (ADR-0006) ───────────────────────────────────────────
		// The overwhelmingly common case — "I paid Nan back" — cannot pick the wrong
		// payer, because the agent does not pick it: it is the key owner's own member,
		// derived server-side. If the caller has no active member row they cannot be the
		// implicit payer — a self-correctable validation_error, not an opaque throw.
		const payerId = from ?? selfMemberId(members);
		if (payerId === null) {
			return toolError(
				'validation_error',
				'You are not an active member of this group, so `from` cannot default to you. ' +
					'Pass an explicit `from` member id from `list_members`.'
			);
		}

		// A self-settlement is meaningless: it nets to zero and puts a phantom payment on
		// the ledger. REST refuses it in its request schema; here it CANNOT live in the
		// Zod schema, because `from` may be absent and the collision only appears once the
		// default is resolved — the likely agent error is exactly that, passing its OWN id
		// as `to` while omitting `from`. `createTransaction` does not catch this (a
		// self-transfer breaks none of its rules), so this check is load-bearing, not a
		// belt-and-braces copy of a guard downstream.
		if (payerId === to) {
			return toolError(
				'validation_error',
				from === undefined
					? 'The payer and payee are the same member: `from` defaults to YOUR own member, ' +
							'and `to` is also you. `to` must be the member you PAID — call `list_members` ' +
							'and pick the other person.'
					: 'The payer and payee must be different members — a settle-up from someone to ' +
							'themselves records nothing.'
			);
		}

		// ADR-0004: parse the decimal string into minor units via the SETTLEMENT currency's
		// own exponent. This is where "1200.005"/THB, negatives and junk become the HARD
		// error the ADR requires — caught here so it surfaces as a self-correctable
		// validation_error, never an opaque internal_error. (A zero amount is left to the
		// shared schema's `amountTotal > 0` rule, one authority for one fact.)
		let minor: number;
		try {
			minor = parseAmount(amount, settlementCurrency);
		} catch (err) {
			return toolError(
				'validation_error',
				err instanceof Error ? err.message : 'The amount could not be parsed.'
			);
		}

		// The §16.4 settle-up shape, IDENTICAL to the REST sugar endpoint's: a
		// single-payer / single-beneficiary Transfer at rate 1 in the settlement currency
		// (so `amountTotalSettlement == amountTotal`), category "Debt settlement". The
		// lone beneficiary under an equal split receives the whole amount. `date` is
		// omitted so the shared schema defaults it to today (§7.1). `createTransaction`
		// RE-VALIDATES all of it — an unknown / other-group / deactivated `from` or `to`
		// throws `TransactionValidationError` → `validation_error`.
		const input = {
			type: 'transfer' as const,
			title: DEBT_SETTLEMENT_TITLE,
			categoryId: DEBT_SETTLEMENT_CATEGORY,
			amountTotal: minor,
			currency: settlementCurrency,
			exchangeRate: '1',
			amountTotalSettlement: minor,
			splitMode: 'equal' as const,
			payers: [{ memberId: payerId, amountPaid: minor }],
			beneficiaries: [{ memberId: to }],
			items: [],
			charges: []
		};

		// ── The WRITE, guarded by the server-derived ~60s window (ADR-0005, #33) ──
		//
		// Everything above is validation and none of it has touched the ledger — which is
		// why the guard starts HERE: a settle-up that was going to be rejected never
		// inserts an idempotency row, so the agent's corrected retry meets a clean path.
		//
		// The key is derived from the RAW arguments the model sent, not the resolved ones:
		// it answers "did the model already send me exactly this?", and resolving `from`
		// first would make an explicit `from` collide with an omitted one.
		const { response, replayedAfterMs } = await withDerivedIdempotency({
			keyId: principal.keyId,
			groupId,
			toolName: TOOL_NAME,
			args: { groupId, to, from, amount },
			store: createDbIdempotencyStore(),
			fn: async () => {
				// Create + AUDIT in one DB transaction (§12.1). `auditVia(principal)` carries the
				// key's `viaKey` provenance into the audit row — we never write audit ourselves.
				const txnId = await createTransaction({
					userId: principal.userId,
					groupId,
					input,
					settlementCurrency,
					via: auditVia(principal)
				});

				// Re-read the PERSISTED detail and project both echo forms (see `../view/echo`):
				//   - `recorded`: the structured view, every name wrapped + attributed (ADR-0003);
				//   - `echo`:     the prose that names the humans (ADR-0006 legibility).
				const detail = await getTransactionDetail({ userId: principal.userId, groupId, txnId });
				const recorded = toTransactionView({ detail, members, principal });

				// The "other Nan" check — AFTER the write, over the roster, purely for the
				// prose. The payer is excluded: they are already named in the sentence, so
				// "the other similarly-named member" must never be one of the two people the
				// settle-up is between.
				const similar = similarlyNamedMembers({ members, targetId: to, excludeIds: [payerId] });

				const payload: SettledPayload = {
					recorded,
					echo: buildSettleUpEchoBack({ view: recorded, minorUnits: minor, similar }),
					similarNames: similar,
					// The prose inlines member display names for legibility — so the result carries
					// the untrusted-note, marking any name in the payload as DATA, and every name it
					// inlines is ALSO present wrapped: the two parties in `recorded`, anyone else in
					// `similarNames` (ADR-0003).
					_note: UNTRUSTED_NOTE
				};
				// `status` is the REST store's shape (§16.6); MCP has no HTTP status for a tool
				// result, so it is a fixed 200 and only `body` is ever read back on this path.
				return { status: 200, body: payload };
			}
		});

		const payload = response.body as SettledPayload;

		// The ordinary path: the settle-up was recorded, exactly once.
		if (replayedAfterMs === null) {
			return toolSuccess({ ...payload, replayed: false });
		}

		// A REPLAY: the window absorbed a retry. A SUCCESS — the user's intent (one
		// payment on the ledger) holds — but told PLAINLY rather than hidden, so the agent
		// cannot report a second payment that does not exist. The full wrapped views still
		// ship; only the leading prose changes, and `replayed` states it machine-readably.
		// (The replay prose carries the original echo verbatim, disambiguation included:
		// the "other Nan" is exactly as relevant on the retry as it was on the create.)
		return toolSuccess({
			...payload,
			replayed: true,
			recordedAgoSeconds: Math.round(replayedAfterMs / 1000),
			echo: buildReplayEchoBack({ recordedEcho: payload.echo, replayedAfterMs })
		});
	}
};
