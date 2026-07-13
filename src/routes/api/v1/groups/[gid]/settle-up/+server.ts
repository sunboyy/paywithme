// POST /api/v1/groups/{gid}/settle-up — settle-up SUGAR endpoint (PLAN §16.4, §8.4).
//
// A thin façade over `createTransaction`: it takes `{ from, to, amount }` and
// builds the single-payer / single-beneficiary TRANSFER that records `from` paying
// `to` — currency = the group's SETTLEMENT currency at rate 1, category "Debt
// settlement" — then delegates to the existing create path. No new domain logic:
// the built input is the full internal `TransactionInput`, so `createTransaction`
// re-validates it against the group's active members (an unknown `from`/`to` → 422)
// and the §7.6 rules exactly like a hand-built create. `amount` is in the group's
// settlement-currency MINOR UNITS (settlement is group context, so a bare integer
// is unambiguous — no float parsing, mirroring the web §8.4 prefill).
//
// A WRITE endpoint: the §16.2 scope guard runs FIRST (read key → 403). The
// settlement currency is loaded from the group row (NEVER trusted from the payload);
// a group the key can't see → 404 (conflated). On success we re-read the persisted
// detail and return the `TransactionDetail` DTO, 201 Created (§16.4 response table).

import { z } from 'zod';
import { getGroupForUser } from '$lib/server/groups';
import { createTransaction, getTransactionDetail } from '$lib/server/transactions';
import { toTransactionDetailDto } from '$lib/server/api/v1';
import { withWriteErrorHandling, readRawJsonBody } from '$lib/server/api/write';
import { requireWriteScope } from '$lib/server/api/scope';
import { auditVia } from '$lib/server/api/provenance';
import { requireRateLimit } from '$lib/server/api/rate-limit';
import { runCreateWithIdempotency } from '$lib/server/api/create';
import { notFound, unauthorized, validationError } from '$lib/server/api/errors';
import type { CurrencyCode } from '$lib/money';

/** The transfer category every settle-up records under (PLAN §8.4 / §16.4). */
const DEBT_SETTLEMENT_CATEGORY = 'transfer-debt-settlement';

/**
 * The settle-up request body (§16.4): the debtor `from`, the creditor `to`, and the
 * `amount` in the group's settlement-currency minor units. `from`/`to` must be
 * distinct (a self-settlement is meaningless — and would net to zero). Full
 * member-existence is left to `createTransaction`'s shared-schema allow-list (an
 * unknown id → 422), so this only checks the transport shape.
 */
const settleUpSchema = z
	.object({
		from: z.string().trim().min(1, { message: 'A payer member is required' }),
		to: z.string().trim().min(1, { message: 'A recipient member is required' }),
		amount: z
			.number({ message: 'An amount is required' })
			.int({ message: 'Amount must be in whole minor units' })
			.positive({ message: 'Amount must be greater than zero' })
			.safe({ message: 'Amount is out of range' })
	})
	.refine((b) => b.from !== b.to, {
		message: 'The payer and recipient must be different members',
		path: ['to']
	});

export const POST = withWriteErrorHandling(async ({ locals, params, request }) => {
	const principal = locals.apiKey;
	if (!principal) return unauthorized();
	// §16.2 write-guard FIRST: a read key can never move money (→ 403).
	const denied = requireWriteScope(principal);
	if (denied) return denied;

	const { gid } = params;
	if (!gid) return notFound();

	// TIER-2 write limiter (§16.7): 20/60s per key, AFTER the scope guard so a read
	// key gets 403 (not 429) and never consumes this counter.
	const limited = await requireRateLimit(principal, 'write');
	if (limited) return limited;

	// Read the raw body ONCE (for the §16.6 fingerprint) and parse it. Unparseable →
	// 400 (via the wrapper). Then validate the {from,to,amount} shape → 422 with
	// field-level details on failure.
	const { raw: rawBody, value: rawJson } = await readRawJsonBody(request);
	const parsed = settleUpSchema.safeParse(rawJson);
	if (!parsed.success) return validationError(parsed.error);
	const { from, to, amount } = parsed.data;

	// Settlement currency is GROUP CONTEXT — load it from the group row (a group the
	// key can't see → 404, conflated). NEVER trusted from the payload.
	const group = await getGroupForUser(principal.userId, gid);
	if (!group) return notFound();
	const settlementCurrency = group.settlementCurrency as CurrencyCode;

	// Build the single-payer / single-beneficiary Transfer at rate 1 (currency ==
	// settlement, so `amountTotalSettlement == amountTotal == amount`), category
	// "Debt settlement". Equal split with the lone beneficiary = the creditor
	// receives the whole amount (mirrors the web §8.4 prefill). `date` is omitted so
	// the shared schema defaults it to today.
	const input = {
		type: 'transfer' as const,
		title: 'Debt settlement',
		categoryId: DEBT_SETTLEMENT_CATEGORY,
		amountTotal: amount,
		currency: settlementCurrency,
		exchangeRate: '1',
		amountTotalSettlement: amount,
		splitMode: 'equal' as const,
		payers: [{ memberId: from, amountPaid: amount }],
		beneficiaries: [{ memberId: to }],
		items: [],
		charges: []
	};

	// Delegate to the existing create path (re-validates against active members →
	// unknown from/to = 422; GroupAccessError → 404). Pass the loaded settlement
	// currency (trusted group context). Wrapped so a repeated Idempotency-Key replays
	// the stored 201 instead of recording the settle-up transfer twice (§16.6).
	const build = async () => {
		const txnId = await createTransaction({
			userId: principal.userId,
			groupId: gid,
			input,
			settlementCurrency,
			// §16.2 audit provenance: a settle-up recorded through a key is attributable to
			// that key (metadata + summary suffix) while the actor stays the user.
			via: auditVia(principal)
		});
		const detail = await getTransactionDetail({
			userId: principal.userId,
			groupId: gid,
			txnId
		});
		return { status: 201, body: toTransactionDetailDto(detail) };
	};

	return runCreateWithIdempotency({
		keyId: principal.keyId,
		idempotencyKeyHeader: request.headers.get('Idempotency-Key'),
		rawBody,
		build
	});
});
