// Unit test for POST /api/v1/groups/{gid}/transactions/{txid}/restore (PLAN §16.4,
// §16.5, §9). HTTP-boundary test with a REAL principal + the REAL
// `toTransactionDetailDto` mapper; only `restoreTransaction` + `getTransactionDetail`
// are overridden (via `importOriginal`, so the real domain error classes stay intact
// for the wrapper's `instanceof` checks). Asserts: happy path → 200 DTO with
// `deletedAt` back to null; a read key → 403 forbidden_scope (service never called);
// absent / no access → the CONFLATED 404.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { restoreTransaction, getTransactionDetail } = vi.hoisted(() => ({
	restoreTransaction: vi.fn(),
	getTransactionDetail: vi.fn()
}));
vi.mock('$lib/server/transactions', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/transactions')>();
	return { ...actual, restoreTransaction, getTransactionDetail };
});

// §16.7 tier-2 write limiter: stubbed to allow (logic covered in api/rate-limit.test.ts).
const { requireRateLimit } = vi.hoisted(() => ({ requireRateLimit: vi.fn() }));
vi.mock('$lib/server/api/rate-limit', () => ({ requireRateLimit }));

import { POST } from './+server';
import { TransactionNotFoundError } from '$lib/server/transactions';
import { GroupAccessError } from '$lib/server/groups';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';

const readPrincipal: ApiKeyPrincipal = {
	keyId: 'key_r',
	userId: 'user_1',
	permissions: { api: ['read'] }
};
const writePrincipal: ApiKeyPrincipal = {
	keyId: 'key_w',
	userId: 'user_1',
	permissions: { api: ['read', 'write'] }
};

function makeEvent(apiKey: ApiKeyPrincipal = writePrincipal, gid = 'g1', txid = 't1') {
	const url = new URL(`http://localhost/api/v1/groups/${gid}/transactions/${txid}/restore`);
	return {
		locals: { apiKey },
		url,
		request: new Request(url, { method: 'POST' }),
		params: { gid, txid }
	} as unknown as Parameters<typeof POST>[0];
}

async function read(res: Response) {
	return { status: res.status, body: await res.json() };
}

const liveDetail = {
	id: 't1',
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
	// Restored → deletedAt back to null (§9).
	deletedAt: null,
	payers: [{ memberId: 'm1', amountPaid: 9000 }],
	shares: [{ memberId: 'm1', amountOwed: 9000 }],
	items: [],
	charges: [],
	input: { type: 'spending', title: 'Dinner', secret: 'internal' }
};

beforeEach(() => {
	vi.clearAllMocks();
	requireRateLimit.mockResolvedValue(null);
});

describe('POST /api/v1/groups/{gid}/transactions/{txid}/restore', () => {
	it('happy path → 200 with the detail DTO carrying `deletedAt` null', async () => {
		restoreTransaction.mockResolvedValue(undefined);
		getTransactionDetail.mockResolvedValue(liveDetail);

		const { status, body } = await read((await POST(makeEvent())) as Response);
		expect(status).toBe(200);
		expect(restoreTransaction).toHaveBeenCalledWith({
			userId: 'user_1',
			groupId: 'g1',
			txnId: 't1',
			actorUserId: 'user_1'
		});
		expect(body.deletedAt).toBeNull();
		expect(body).not.toHaveProperty('input');
	});

	it('read key → 403 forbidden_scope; the service is never called', async () => {
		const { status, body } = await read((await POST(makeEvent(readPrincipal))) as Response);
		expect(status).toBe(403);
		expect(body.error.code).toBe('forbidden_scope');
		expect(restoreTransaction).not.toHaveBeenCalled();
	});

	it('absent / no access → 404 not_found (conflated)', async () => {
		restoreTransaction.mockRejectedValue(new TransactionNotFoundError());
		const notFound = await read((await POST(makeEvent())) as Response);
		expect(notFound.status).toBe(404);
		expect(notFound.body.error.code).toBe('not_found');

		restoreTransaction.mockRejectedValue(new GroupAccessError());
		const noAccess = await read((await POST(makeEvent())) as Response);
		// Indistinguishable from "doesn't exist".
		expect(noAccess.body).toEqual(notFound.body);
	});
});
