// Unit test for GET /api/v1/groups/{gid}/transactions (PLAN §16.4, §16.5, §10).
//
// HTTP-boundary test with a REAL principal + the REAL `toTransactionListItemDto`
// mapper and REAL cursor codec; only `listTransactions` is overridden (via
// `importOriginal`, so the real cursor helpers + domain error classes stay intact).
// Covers the acceptance criteria for this endpoint:
//   - filters + limit are parsed and FORWARDED to the service (asserting the args);
//   - the service is over-fetched by one (`limit + 1`) to detect a next page;
//   - `nextCursor` is minted from the LAST SERVED row when a full+1 page comes back,
//     and is `null` otherwise — and it round-trips through the real decoder;
//   - a bad `limit` / unparseable `from` → 422 (not 500, not silently ignored);
//   - a bad cursor (service throws `TransactionCursorError`) → 400 (not 500);
//   - no access (`GroupAccessError`) → the CONFLATED 404 `not_found`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GroupAccessError } from '$lib/server/groups';

const { listTransactions, createTransaction, getTransactionDetail } = vi.hoisted(() => ({
	listTransactions: vi.fn(),
	createTransaction: vi.fn(),
	getTransactionDetail: vi.fn()
}));
vi.mock('$lib/server/transactions', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/transactions')>();
	return { ...actual, listTransactions, createTransaction, getTransactionDetail };
});

// Swap ONLY the DB-backed idempotency store for an in-memory one (§16.6) so the
// header path exercises the REAL `withIdempotency` semantics without a database.
const { memoryStore } = vi.hoisted(() => {
	type Row = {
		requestHash: string;
		status: 'pending' | 'completed';
		responseStatus: number | null;
		responseBody: unknown;
	};
	const rows = new Map<string, Row>();
	const k = (keyId: string, ik: string) => `${keyId}::${ik}`;
	const memoryStore = {
		rows,
		async insertPending(row: {
			keyId: string;
			idempotencyKey: string;
			requestHash: string;
		}): Promise<boolean> {
			const key = k(row.keyId, row.idempotencyKey);
			if (rows.has(key)) return false;
			rows.set(key, {
				requestHash: row.requestHash,
				status: 'pending',
				responseStatus: null,
				responseBody: null
			});
			return true;
		},
		async load(keyId: string, ik: string): Promise<Row | null> {
			return rows.get(k(keyId, ik)) ?? null;
		},
		async markCompleted(
			keyId: string,
			ik: string,
			response: { status: number; body: unknown }
		): Promise<void> {
			const row = rows.get(k(keyId, ik));
			if (row) {
				row.status = 'completed';
				row.responseStatus = response.status;
				row.responseBody = response.body;
			}
		}
	};
	return { memoryStore };
});
vi.mock('$lib/server/api/idempotency', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/api/idempotency')>();
	return { ...actual, createDbIdempotencyStore: () => memoryStore };
});

// §16.7 tier-2 limiter: stubbed to allow by default (logic covered in
// `api/rate-limit.test.ts`); flipped to 429 to prove the read/write wiring + order.
const { requireRateLimit } = vi.hoisted(() => ({ requireRateLimit: vi.fn() }));
vi.mock('$lib/server/api/rate-limit', () => ({ requireRateLimit }));

import { GET, POST } from './+server';
import { rateLimited } from '$lib/server/api/errors';
import {
	createdAtInRange,
	decodeTransactionCursor,
	TransactionCursorError,
	TransactionValidationError
} from '$lib/server/transactions';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';

const principal: ApiKeyPrincipal = {
	keyId: 'key_1',
	userId: 'user_1',
	permissions: { api: ['read'] }
};

/** A write-scoped principal (§16.2 `write ⊇ read`). */
const writePrincipal: ApiKeyPrincipal = {
	keyId: 'key_w',
	userId: 'user_1',
	permissions: { api: ['read', 'write'] }
};

function makeEvent(query = '', gid = 'g1') {
	const url = new URL(`http://localhost/api/v1/groups/${gid}/transactions${query}`);
	return {
		locals: { apiKey: principal },
		url,
		request: new Request(url),
		params: { gid }
	} as unknown as Parameters<typeof GET>[0];
}

/** A POST event with a JSON (or raw) body + a chosen principal (defaults write). */
function makePostEvent(
	body: unknown,
	{
		gid = 'g1',
		apiKey = writePrincipal,
		raw,
		idempotencyKey
	}: { gid?: string; apiKey?: ApiKeyPrincipal; raw?: string; idempotencyKey?: string } = {}
) {
	const url = new URL(`http://localhost/api/v1/groups/${gid}/transactions`);
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
	const request = new Request(url, {
		method: 'POST',
		headers,
		body: raw ?? JSON.stringify(body)
	});
	return {
		locals: { apiKey },
		url,
		request,
		params: { gid }
	} as unknown as Parameters<typeof POST>[0];
}

/** A minimal persisted detail the create path re-reads for its 201 DTO. */
const createdDetail = {
	id: 't_new',
	groupId: 'g1',
	type: 'spending' as const,
	title: 'Dinner',
	categoryId: 'spending-food-drink',
	categoryName: 'Food',
	categoryIcon: 'utensils',
	amountTotal: 9000,
	currency: 'THB' as const,
	amountTotalSettlement: 9000,
	settlementCurrency: 'THB' as const,
	isForeign: false,
	splitMode: 'equal' as const,
	createdAt: '2026-01-02T12:00:00.000Z',
	deletedAt: null,
	payers: [{ memberId: 'm1', amountPaid: 9000 }],
	shares: [{ memberId: 'm1', amountOwed: 9000 }],
	items: [],
	charges: [],
	input: { type: 'spending', title: 'Dinner', secret: 'internal' }
};

async function read(res: Response) {
	return { status: res.status, body: await res.json() };
}

/** Build `n` list items with deterministic, strictly-decreasing sort keys. */
function items(n: number) {
	return Array.from({ length: n }, (_, i) => ({
		id: `t${i}`,
		type: 'spending' as const,
		title: `Txn ${i}`,
		categoryId: 'food',
		categoryName: 'Food',
		categoryIcon: 'utensils',
		amountTotal: 1000 + i,
		currency: 'THB' as const,
		amountTotalSettlement: 1000 + i,
		settlementCurrency: 'THB' as const,
		isForeign: false,
		createdAt: `2026-01-${String(28 - i).padStart(2, '0')}T12:00:00.000Z`,
		occurredAt: `2026-01-${String(28 - i).padStart(2, '0')}T09:00:00.000Z`
	}));
}

beforeEach(() => {
	vi.clearAllMocks();
	memoryStore.rows.clear();
	requireRateLimit.mockResolvedValue(null);
});

describe('GET /api/v1/groups/{gid}/transactions', () => {
	it('default limit 50: over-fetches 51 and forwards empty filters', async () => {
		listTransactions.mockResolvedValue(items(3));
		const { status, body } = await read((await GET(makeEvent())) as Response);
		expect(status).toBe(200);
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'user_1',
			groupId: 'g1',
			filters: {},
			limit: 51
		});
		expect(body.data).toHaveLength(3);
		expect(body.nextCursor).toBeNull();
	});

	it('parses + forwards type/categoryId/from/to/cursor and limit+1', async () => {
		listTransactions.mockResolvedValue(items(1));
		await GET(
			makeEvent(
				'?type=spending&categoryId=food&from=2026-01-01&to=2026-01-31&cursor=OPAQUE&limit=2'
			)
		);
		const arg = listTransactions.mock.calls[0][0];
		expect(arg.limit).toBe(3);
		expect(arg.filters.type).toBe('spending');
		expect(arg.filters.categoryId).toBe('food');
		expect(arg.filters.after).toBe('OPAQUE');
		expect(arg.filters.from).toBeInstanceOf(Date);
		// `from` stays start-of-day (midnight `gte` already includes that day's noon rows).
		expect(arg.filters.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
		// `to` is rolled forward to END-OF-DAY UTC so a noon-anchored txn ON the `to`
		// day is INCLUDED (else `lte(createdAt=…T12:00, to=…T00:00)` would drop it).
		expect(arg.filters.to.toISOString()).toBe('2026-01-31T23:59:59.999Z');
	});

	it('the forwarded end-of-day `to` genuinely includes a noon-anchored row on that day', () => {
		// Prove the fix end-to-end against the REAL range predicate: the `createdAt` of
		// a txn dated exactly on the `to` day (noon UTC, per `dateOnlyToCreatedAt`) must
		// fall inside `[from, endOfUtcDay(to)]` — and would FAIL against a midnight `to`.
		const from = new Date('2026-01-01T00:00:00.000Z');
		const midnightTo = new Date('2026-01-31T00:00:00.000Z');
		const endOfDayTo = new Date('2026-01-31T23:59:59.999Z');
		const noonOnToDay = new Date('2026-01-31T12:00:00.000Z');
		expect(createdAtInRange(noonOnToDay, from, midnightTo)).toBe(false); // the bug
		expect(createdAtInRange(noonOnToDay, from, endOfDayTo)).toBe(true); // the fix
	});

	it('full+1 page → serves `limit` rows and mints a round-tripping nextCursor', async () => {
		// limit=2, service returns 3 (limit + 1) → there IS a next page.
		listTransactions.mockResolvedValue(items(3));
		const { body } = await read((await GET(makeEvent('?limit=2'))) as Response);
		expect(body.data).toHaveLength(2);
		expect(body.nextCursor).toEqual(expect.any(String));

		// The cursor is minted from the LAST SERVED row (index 1) and round-trips.
		const key = decodeTransactionCursor(body.nextCursor);
		expect(key.id).toBe('t1');
		expect(key.createdAt.toISOString()).toBe('2026-01-27T12:00:00.000Z');
		expect(key.occurredAt.toISOString()).toBe('2026-01-27T09:00:00.000Z');
	});

	it('exactly `limit` rows (no extra) → nextCursor null', async () => {
		listTransactions.mockResolvedValue(items(2));
		const { body } = await read((await GET(makeEvent('?limit=2'))) as Response);
		expect(body.data).toHaveLength(2);
		expect(body.nextCursor).toBeNull();
	});

	it('limit above the max → 422 validation_error (not a silent clamp)', async () => {
		const { status, body } = await read((await GET(makeEvent('?limit=101'))) as Response);
		expect(status).toBe(422);
		expect(body.error.code).toBe('validation_error');
		expect(listTransactions).not.toHaveBeenCalled();
	});

	it('non-integer limit → 422 validation_error', async () => {
		const { status, body } = await read((await GET(makeEvent('?limit=2.5'))) as Response);
		expect(status).toBe(422);
		expect(body.error.code).toBe('validation_error');
	});

	it('unparseable from date → 422 validation_error', async () => {
		const { status, body } = await read((await GET(makeEvent('?from=not-a-date'))) as Response);
		expect(status).toBe(422);
		expect(body.error.code).toBe('validation_error');
	});

	it('bad cursor (service throws TransactionCursorError) → 400 bad_request, not 500', async () => {
		listTransactions.mockRejectedValue(new TransactionCursorError());
		const { status, body } = await read((await GET(makeEvent('?cursor=garbage'))) as Response);
		expect(status).toBe(400);
		expect(body.error.code).toBe('bad_request');
	});

	it('no access (GroupAccessError) → 404 not_found (conflated)', async () => {
		listTransactions.mockRejectedValue(new GroupAccessError());
		const { status, body } = await read((await GET(makeEvent())) as Response);
		expect(status).toBe(404);
		expect(body.error.code).toBe('not_found');
	});
});

describe('POST /api/v1/groups/{gid}/transactions', () => {
	const validInput = {
		type: 'spending',
		title: 'Dinner',
		categoryId: 'spending-food-drink',
		amountTotal: 9000,
		currency: 'THB',
		exchangeRate: '1',
		amountTotalSettlement: 9000,
		splitMode: 'equal',
		payers: [{ memberId: 'm1', amountPaid: 9000 }],
		beneficiaries: [{ memberId: 'm1' }],
		items: [],
		charges: []
	};

	it('happy path → 201 with the detail DTO; forwards the raw input; drops `input`', async () => {
		createTransaction.mockResolvedValue('t_new');
		getTransactionDetail.mockResolvedValue(createdDetail);

		const { status, body } = await read((await POST(makePostEvent(validInput))) as Response);
		expect(status).toBe(201);
		// The FULL internal input is forwarded verbatim (no separate write DTO); the
		// settlement currency is NOT taken from the payload (service loads it).
		expect(createTransaction).toHaveBeenCalledWith({
			userId: 'user_1',
			groupId: 'g1',
			input: validInput
		});
		expect(getTransactionDetail).toHaveBeenCalledWith({
			userId: 'user_1',
			groupId: 'g1',
			txnId: 't_new'
		});
		expect(body.amount).toEqual({ amount: 9000, currency: 'THB' });
		expect(body).not.toHaveProperty('input');
	});

	it('read key → 403 forbidden_scope; the service is never called', async () => {
		const { status, body } = await read(
			(await POST(makePostEvent(validInput, { apiKey: principal }))) as Response
		);
		expect(status).toBe(403);
		expect(body.error.code).toBe('forbidden_scope');
		expect(createTransaction).not.toHaveBeenCalled();
		// §16.7: a read key hitting a write endpoint gets 403, NOT 429, and never
		// consumes the write counter (the scope guard runs before requireRateLimit).
		expect(requireRateLimit).not.toHaveBeenCalled();
	});

	it('429 rate_limited (tier-2 write) short-circuits AFTER the scope check, before the create', async () => {
		requireRateLimit.mockResolvedValueOnce(
			rateLimited(
				'Rate limit exceeded.',
				{ scope: 'write', limit: 20, windowSeconds: 60, retryAfterSeconds: 12 },
				12
			)
		);
		const res = (await POST(makePostEvent(validInput))) as Response;
		expect(res.status).toBe(429);
		expect(res.headers.get('Retry-After')).toBe('12');
		const body = await res.json();
		expect(body.error.code).toBe('rate_limited');
		expect(body.error.details).toEqual({
			scope: 'write',
			limit: 20,
			windowSeconds: 60,
			retryAfterSeconds: 12
		});
		// The write counter is consumed with the 'write' class; the create never runs.
		expect(requireRateLimit).toHaveBeenCalledWith(writePrincipal, 'write');
		expect(createTransaction).not.toHaveBeenCalled();
	});

	it('amountTotalSettlement mismatch → 422 with field-level details', async () => {
		// The service re-validates via the shared schema; a §7.6 mismatch throws
		// TransactionValidationError carrying the offending field.
		createTransaction.mockRejectedValue(
			new TransactionValidationError([
				{
					code: 'custom',
					path: ['amountTotalSettlement'],
					message: 'The settlement total must equal the converted transaction total'
				} as never
			])
		);
		const { status, body } = await read(
			(await POST(makePostEvent({ ...validInput, amountTotalSettlement: 8888 }))) as Response
		);
		expect(status).toBe(422);
		expect(body.error.code).toBe('validation_error');
		expect(body.error.details.fieldErrors.amountTotalSettlement).toEqual([
			'The settlement total must equal the converted transaction total'
		]);
	});

	it('unparseable JSON body → 400 bad_request', async () => {
		const { status, body } = await read(
			(await POST(makePostEvent(null, { raw: '{not json' }))) as Response
		);
		expect(status).toBe(400);
		expect(body.error.code).toBe('bad_request');
		expect(createTransaction).not.toHaveBeenCalled();
	});

	it('no access (GroupAccessError) → 404 not_found (conflated)', async () => {
		createTransaction.mockRejectedValue(new GroupAccessError());
		const { status, body } = await read((await POST(makePostEvent(validInput))) as Response);
		expect(status).toBe(404);
		expect(body.error.code).toBe('not_found');
	});

	describe('Idempotency-Key (§16.6)', () => {
		it('same key + same body → the service runs ONCE and the 2nd call REPLAYS the 201', async () => {
			createTransaction.mockResolvedValue('t_new');
			getTransactionDetail.mockResolvedValue(createdDetail);

			const first = await read(
				(await POST(makePostEvent(validInput, { idempotencyKey: 'key-1' }))) as Response
			);
			const second = await read(
				(await POST(makePostEvent(validInput, { idempotencyKey: 'key-1' }))) as Response
			);

			expect(first.status).toBe(201);
			expect(second.status).toBe(201);
			// The stored response is replayed byte-for-byte — no duplicate create.
			expect(second.body).toEqual(first.body);
			expect(createTransaction).toHaveBeenCalledTimes(1);
			expect(getTransactionDetail).toHaveBeenCalledTimes(1);
		});

		it('same key + DIFFERENT body → 409 conflict (key_reused); no second create', async () => {
			createTransaction.mockResolvedValue('t_new');
			getTransactionDetail.mockResolvedValue(createdDetail);

			const first = await read(
				(await POST(makePostEvent(validInput, { idempotencyKey: 'key-2' }))) as Response
			);
			expect(first.status).toBe(201);

			const second = await read(
				(await POST(
					makePostEvent({ ...validInput, title: 'Different' }, { idempotencyKey: 'key-2' })
				)) as Response
			);
			expect(second.status).toBe(409);
			expect(second.body.error.code).toBe('conflict');
			expect(second.body.error.details.reason).toBe('key_reused');
			expect(createTransaction).toHaveBeenCalledTimes(1);
		});

		it('a still-pending row (concurrent retry) → 409 conflict (in_progress)', async () => {
			// Seed a pending row for this key+body, simulating a concurrent request that
			// won the pending-first insert and is still running.
			const raw = JSON.stringify(validInput);
			const { fingerprintRequestBody } = await import('$lib/server/api/idempotency');
			memoryStore.rows.set(`${writePrincipal.keyId}::key-3`, {
				requestHash: fingerprintRequestBody(raw),
				status: 'pending',
				responseStatus: null,
				responseBody: null
			});

			const { status, body } = await read(
				(await POST(makePostEvent(validInput, { idempotencyKey: 'key-3' }))) as Response
			);
			expect(status).toBe(409);
			expect(body.error.code).toBe('conflict');
			expect(body.error.details.reason).toBe('in_progress');
			// The create is never attempted — the row is already claimed.
			expect(createTransaction).not.toHaveBeenCalled();
		});

		it('NO header → the service runs on every call (at-least-once, unchanged)', async () => {
			createTransaction.mockResolvedValue('t_new');
			getTransactionDetail.mockResolvedValue(createdDetail);

			await read((await POST(makePostEvent(validInput))) as Response);
			await read((await POST(makePostEvent(validInput))) as Response);
			expect(createTransaction).toHaveBeenCalledTimes(2);
		});
	});
});
