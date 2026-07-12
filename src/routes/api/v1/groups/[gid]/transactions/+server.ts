// GET /api/v1/groups/{gid}/transactions — the paginated, filterable transaction
// list (PLAN §16.4, §7.6, §10).
//
// The ONLY paginated collection (§16.4): a keyset cursor over the total order
// `(createdAt DESC, occurredAt DESC, id)`, stable under concurrent inserts.
// Response shape: `{ data: TransactionListItemDto[], nextCursor: string | null }`.
//
// ── Query params (§16.4) ──────────────────────────────────────────────────────
//   - `limit`      ≤ 100, default 50 (integer). Out-of-range / non-integer → 422.
//   - `cursor`     opaque `after` token; an undecodable one → 400 (via the service
//                  throwing `TransactionCursorError`, translated by the wrapper).
//   - `type`       'spending' | 'transfer'.
//   - `categoryId` a category id.
//   - `from`/`to`  INCLUSIVE date range on `createdAt` (the §7.1 real-world date);
//                  an unparseable date → 422. A bare `to=YYYY-MM-DD` coerces to that
//                  day's MIDNIGHT UTC, but every `createdAt` is anchored at NOON UTC
//                  of its calendar day (`dateOnlyToCreatedAt`), and the service
//                  applies `lte(createdAt, to)` — so a bare `to` is rolled forward to
//                  END-OF-DAY UTC (`23:59:59.999`) here, otherwise a txn dated exactly
//                  on the `to` day (noon) would be silently EXCLUDED from a range this
//                  contract documents as inclusive. `from` needs no adjustment
//                  (midnight `gte` already includes that day's noon rows).
// Structured params are validated by a Zod schema → 422 `validation_error` (with
// field details); the opaque cursor is the one 400 `bad_request` case. See
// `$lib/server/api/read` for why the two are split that way.
//
// ── Pagination (mint the next cursor) ─────────────────────────────────────────
// We ask the service for `limit + 1` rows. If it returns more than `limit`, there
// IS a next page: we serve the first `limit` mapped rows and mint `nextCursor`
// from the LAST SERVED row's full sort key. Otherwise `nextCursor` is `null`. The
// service enforces NO default/max limit — that clamp is this layer's job (§16.4).
// Any valid key suffices (an `R` endpoint).

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import {
	listTransactions,
	createTransaction,
	getTransactionDetail,
	encodeTransactionCursor,
	type TransactionListFilters
} from '$lib/server/transactions';
import { toTransactionListItemDto, toTransactionDetailDto } from '$lib/server/api/v1';
import { withReadErrorHandling } from '$lib/server/api/read';
import { withWriteErrorHandling, readRawJsonBody } from '$lib/server/api/write';
import { requireWriteScope } from '$lib/server/api/scope';
import { runCreateWithIdempotency } from '$lib/server/api/create';
import { notFound, unauthorized, validationError } from '$lib/server/api/errors';

/** Default page size when `limit` is omitted (§16.4). */
const DEFAULT_LIMIT = 50;
/** Hard cap on page size (§16.4) — a larger requested `limit` is a 422, not a clamp. */
const MAX_LIMIT = 100;

/**
 * The list query params (§16.4). `limit` coerces to an integer in `[1, MAX_LIMIT]`
 * (default `DEFAULT_LIMIT`); `from`/`to` coerce to a `Date` (an invalid date fails).
 * `cursor` stays a raw opaque string here — it is DECODED by the service, which
 * raises `TransactionCursorError` (→ 400) on a bad value, so we never validate its
 * internal shape at this layer. A schema failure → 422 `validation_error`.
 */
const listQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
	cursor: z.string().min(1).optional(),
	type: z.enum(['spending', 'transfer']).optional(),
	categoryId: z.string().min(1).optional(),
	from: z.coerce.date().optional(),
	to: z.coerce.date().optional()
});

/**
 * Roll a coerced `to` bound forward to END-OF-DAY UTC (`23:59:59.999`) of its
 * calendar day. The range is INCLUSIVE on the §7.1 real-world date, but `createdAt`
 * is stored at NOON UTC of the day, so a bare `to=YYYY-MM-DD` (midnight) would drop
 * that day's rows under the service's `lte(createdAt, to)`. Mirrors the internal
 * end-of-day convention (`transactions.test.ts` passes an end-of-day `to`).
 */
function endOfUtcDay(date: Date): Date {
	return new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999)
	);
}

/** Collect only the PRESENT query params so Zod defaults/optionals behave (absent → undefined). */
function presentParams(url: URL): Record<string, string> {
	const raw: Record<string, string> = {};
	for (const key of ['limit', 'cursor', 'type', 'categoryId', 'from', 'to']) {
		const value = url.searchParams.get(key);
		if (value !== null) raw[key] = value;
	}
	return raw;
}

export const GET = withReadErrorHandling(async ({ locals, params, url }) => {
	const principal = locals.apiKey;
	if (!principal) return unauthorized();

	const { gid } = params;
	if (!gid) return notFound();

	// Validate + coerce the query params. A malformed structured param (bad `limit`,
	// unparseable `from`/`to`) → 422 with field-level details (never a silent ignore,
	// never a 500). The cursor is passed through raw and decoded by the service.
	const parsed = listQuerySchema.safeParse(presentParams(url));
	if (!parsed.success) return validationError(parsed.error);
	const { limit, cursor, type, categoryId, from, to } = parsed.data;

	const filters: TransactionListFilters = {};
	if (type) filters.type = type;
	if (categoryId) filters.categoryId = categoryId;
	if (cursor) filters.after = cursor;
	if (from) filters.from = from;
	// Inclusive upper bound: roll `to` to end-of-day so a noon-anchored txn on that
	// day is INCLUDED (§16.4). `from` stays start-of-day (midnight `gte` includes noon).
	if (to) filters.to = endOfUtcDay(to);

	// Over-fetch by one to detect a next page WITHOUT a second count query. The
	// service throws `GroupAccessError` (→ 404) on no access and
	// `TransactionCursorError` (→ 400) on a bad cursor — both mapped by the wrapper.
	const rows = await listTransactions({
		userId: principal.userId,
		groupId: gid,
		filters,
		limit: limit + 1
	});

	const hasMore = rows.length > limit;
	const pageRows = hasMore ? rows.slice(0, limit) : rows;
	const data = pageRows.map(toTransactionListItemDto);

	// Mint the next cursor from the LAST SERVED row's full §16.4 sort key.
	const last = pageRows.at(-1);
	const nextCursor =
		hasMore && last
			? encodeTransactionCursor({
					createdAt: new Date(last.createdAt),
					occurredAt: new Date(last.occurredAt),
					id: last.id
				})
			: null;

	return json({ data, nextCursor });
});

// POST /api/v1/groups/{gid}/transactions — create a transaction (PLAN §16.4). A
// WRITE endpoint: the scope guard runs FIRST (a read key → 403 `forbidden_scope`,
// §16.2). The body is the FULL internal `TransactionInput` verbatim (reuse of the
// shared `buildTransactionSchema` — no separate write DTO): `createTransaction`
// re-validates it server-side against the group's settlement currency + active
// members (which OWNS the §7.6 `amountTotalSettlement` equality rule, so a
// caller-supplied mismatch surfaces as a 422 via the wrapper). The settlement
// currency is GROUP CONTEXT loaded by the service from the group row — NEVER
// trusted from the payload. On success we re-read the persisted detail and return
// the SAME `TransactionDetail` DTO the GET routes serve (§16.4), 201 Created.
//
// IDEMPOTENCY (§16.6): when an `Idempotency-Key` header is present, the create +
// re-read is run AT MOST ONCE per (calling key + request body) via
// `runCreateWithIdempotency` — a same-body retry replays the stored 201 (no
// duplicate txn / audit row), a different body → 409, a concurrent retry → 409.
// Absent header → at-least-once (unchanged).
export const POST = withWriteErrorHandling(async ({ locals, params, request }) => {
	const principal = locals.apiKey;
	if (!principal) return unauthorized();
	// §16.2 write-guard FIRST: a read key can never move money (→ 403).
	const denied = requireWriteScope(principal);
	if (denied) return denied;

	const { gid } = params;
	if (!gid) return notFound();

	// Read the raw body ONCE (for the §16.6 fingerprint) and parse it. Unparseable →
	// JsonBodyError → 400 (mapped by the wrapper). The parsed value is handed to the
	// service VERBATIM as the full internal input.
	const { raw, value: input } = await readRawJsonBody(request);

	// The create (service call → 422/404 via the wrapper; settlement currency loaded
	// server-side from the group) + the 201 DTO re-read (§16.4). Wrapped so a repeated
	// Idempotency-Key replays this exact response instead of re-running it.
	const build = async () => {
		const txnId = await createTransaction({
			userId: principal.userId,
			groupId: gid,
			input
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
		rawBody: raw,
		build
	});
});
