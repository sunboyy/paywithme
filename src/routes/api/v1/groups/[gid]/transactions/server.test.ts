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

const { listTransactions } = vi.hoisted(() => ({ listTransactions: vi.fn() }));
vi.mock('$lib/server/transactions', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/transactions')>();
	return { ...actual, listTransactions };
});

import { GET } from './+server';
import {
	createdAtInRange,
	decodeTransactionCursor,
	TransactionCursorError
} from '$lib/server/transactions';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';

const principal: ApiKeyPrincipal = {
	keyId: 'key_1',
	userId: 'user_1',
	permissions: { api: ['read'] }
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

beforeEach(() => vi.clearAllMocks());

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
