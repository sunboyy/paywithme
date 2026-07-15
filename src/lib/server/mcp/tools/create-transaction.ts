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
//     insert (§12.1). We never write audit ourselves.
//   - Idempotency: OUT OF SCOPE for #31 (it is #33). A plain at-least-once create is
//     correct here, exactly like the REST POST with NO Idempotency-Key.
//
// v1 shape: a SPENDING with an EQUAL split and a SINGLE payer — the canonical minimal
// shape, mirroring the `spendingInput` fixture the API suites are built on.

import { z } from 'zod';
import { parseAmount } from '$lib/money';
import { categoriesFor } from '$lib/categories';
import { createTransaction, getTransactionDetail } from '$lib/server/transactions';
import { auditVia } from '$lib/server/api/provenance';
import { toolError, toolSuccess } from '../errors';
import { buildEchoBack, selfMemberId, toTransactionView, UNTRUSTED_NOTE } from '../view';
import type { McpTool } from '../types';
import { GROUP_ID_PROPERTY, groupIdArg } from './args';
import { loadGroupView, loadMemberViews } from './load';

/**
 * The ADR-0004 amount shape: a decimal string, no floats, no negatives, at most 4
 * fractional digits (the widest exponent any supported currency uses). This is the
 * FIRST gate; `parseAmount` is the authoritative per-currency one, rejecting more
 * places than the SPECIFIC settlement currency allows (2 for THB, 0 for JPY).
 */
const AMOUNT_REGEX = /^\d+(\.\d{1,4})?$/;

const createTransactionArgs = z.strictObject({
	groupId: groupIdArg,
	title: z.string().min(1, 'A title is required.'),
	amount: z
		.string()
		.regex(
			AMOUNT_REGEX,
			'Amount must be a plain decimal string like "240", "240.00", or "1234.5" — no ' +
				'currency symbols, commas, or negative signs. State it exactly as the user said it.'
		),
	// OPTIONAL: FX is deferred, so this defaults to (and must equal) the group's
	// settlement currency. See the header.
	currency: z.string().min(1).optional(),
	// OPTIONAL: defaults to the CALLER's own member (the `isYou` member).
	paidBy: z.string().min(1).optional(),
	// REQUIRED: the equal-split beneficiaries, by member id (never names, ADR-0006).
	splitBetween: z.array(z.string().min(1)).min(1, 'List at least one member id to split between.'),
	// OPTIONAL: defaults to the first spending category.
	categoryId: z.string().min(1).optional()
});

export const createTransactionTool: McpTool<z.infer<typeof createTransactionArgs>> = {
	scope: 'write',
	rateLimitClass: 'write',
	args: createTransactionArgs,
	definition: {
		name: 'create_transaction',
		title: 'Record a spending',
		description:
			'Record a shared spending (an expense) split EQUALLY between members, with a single ' +
			'payer. IDS ONLY, NEVER NAMES: `paidBy` and every id in `splitBetween` must be member ' +
			'ids from `list_members` — match the person the user named ("split with Nan") to an id ' +
			'YOURSELF and show your reasoning; this tool does no name matching. STATE THE AMOUNT ' +
			'EXACTLY AS THE USER SAID IT ("240", "240.00", "1234.5") as a decimal string — the ' +
			'server does the currency math, so never multiply by 100 or convert exponents. The ' +
			"amount must be in the group's settlement currency (logging a foreign currency via the " +
			'assistant is not supported yet). Defaults: `paidBy` is you, `splitBetween` has no ' +
			'default (you must list it), `currency` is the group settlement currency, `categoryId` ' +
			'is a general spending category. The result echoes back what was recorded, naming the ' +
			'people involved, so you and the user can confirm the interpretation.',
		inputSchema: {
			type: 'object',
			properties: {
				groupId: GROUP_ID_PROPERTY,
				title: {
					type: 'string',
					description: 'A short human title for the spending, e.g. "Lunch". Required.'
				},
				amount: {
					type: 'string',
					description:
						'The amount as a DECIMAL STRING, stated exactly as the user said it: "240", ' +
						'"240.00", "1234.5". No currency symbol, no thousands separators, no negative ' +
						"sign. The server converts to the currency's minor units — do NOT do that math " +
						'yourself.'
				},
				currency: {
					type: 'string',
					description:
						"OPTIONAL ISO-4217 code. Must equal the group's settlement currency (call " +
						'`get_group` to see it); omit to default to it. Foreign-currency logging via the ' +
						'assistant is not supported yet.'
				},
				paidBy: {
					type: 'string',
					description:
						'OPTIONAL member id of who paid, from `list_members`. Defaults to YOU (your own ' +
						'member in this group). Never a name.'
				},
				splitBetween: {
					type: 'array',
					items: { type: 'string' },
					description:
						'REQUIRED array of member ids (from `list_members`) to split the cost equally ' +
						'between. Match each person the user named to an id yourself. Never names.'
				},
				categoryId: {
					type: 'string',
					description:
						'OPTIONAL spending category id. Defaults to a general spending category if omitted.'
				}
			},
			required: ['groupId', 'title', 'amount', 'splitBetween'],
			additionalProperties: false
		},
		annotations: {
			title: 'Record a spending',
			// This tool WRITES: it is not read-only, and (belt-and-braces) is not
			// destructive — it appends a transaction, it never deletes or overwrites one.
			readOnlyHint: false,
			destructiveHint: false,
			// Not idempotent: idempotency keys are #33; a repeated call records a DUPLICATE.
			idempotentHint: false,
			openWorldHint: false
		}
	},
	run: async (
		{ principal },
		{ groupId, title, amount, currency, paidBy, splitBetween, categoryId }
	) => {
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
					`${settlementCurrency}.`
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
					'Pass an explicit `paidBy` member id from `list_members`.'
			);
		}

		// Default the category to a general spending category (§7.3). Unknown / mismatched
		// ids are re-validated server-side by `createTransaction` → validation_error.
		const resolvedCategoryId = categoryId ?? categoriesFor('spending')[0].id;

		// ADR-0004: parse the decimal string into minor units via the SETTLEMENT currency's
		// own exponent. This is where "240.005"/THB, negatives, and junk become the HARD
		// error the ADR requires — caught here so it surfaces as a self-correctable
		// validation_error, never as an opaque internal_error.
		let minor: number;
		try {
			minor = parseAmount(amount, settlementCurrency);
		} catch (err) {
			return toolError(
				'validation_error',
				err instanceof Error ? err.message : 'The amount could not be parsed.'
			);
		}

		// The canonical minimal equal-split spending shape — IDENTICAL to the
		// `spendingInput` fixture the API suites build on. Because v1 records only in the
		// settlement currency, exchangeRate is '1' and the settlement total equals the
		// entry total (no FX). The service RE-VALIDATES this server-side (unknown member
		// ids, category/type mismatch, etc. → TransactionValidationError → validation_error).
		const input = {
			type: 'spending' as const,
			title,
			categoryId: resolvedCategoryId,
			amountTotal: minor,
			currency: settlementCurrency,
			exchangeRate: '1',
			amountTotalSettlement: minor,
			splitMode: 'equal' as const,
			payers: [{ memberId: payerId, amountPaid: minor }],
			beneficiaries: splitBetween.map((memberId) => ({ memberId })),
			items: [],
			charges: []
		};

		// Create + AUDIT in one DB transaction (§12.1). `auditVia(principal)` carries the
		// key's provenance (`viaKey`) into the audit row — audit comes for free, we never
		// write it ourselves.
		const txnId = await createTransaction({
			userId: principal.userId,
			groupId,
			input,
			settlementCurrency,
			via: auditVia(principal)
		});

		// Re-read the persisted detail and project BOTH echo forms (see `../view/echo`):
		//   - `recorded`: the structured view, every name wrapped + attributed (ADR-0003);
		//   - `echo`:     the prose restatement that NAMES the humans (ADR-0006 legibility).
		const detail = await getTransactionDetail({ userId: principal.userId, groupId, txnId });
		const recorded = toTransactionView({ detail, members, principal });
		const echo = buildEchoBack({ view: recorded, minorUnits: minor });

		return toolSuccess({
			recorded,
			echo,
			// The prose inlines member display names for legibility — so the result also
			// carries the untrusted-note, marking any name/title in the payload as DATA,
			// and every such name is ALSO present wrapped inside `recorded` (ADR-0003).
			_note: UNTRUSTED_NOTE
		});
	}
};
