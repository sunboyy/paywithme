// Unit test for GET /api/v1/groups/{gid}/transactions/{txid} (PLAN §16.4, §16.5).
//
// HTTP-boundary test with a REAL principal + the REAL `toTransactionDetailDto`
// mapper; only `getTransactionDetail` is overridden (via `importOriginal`, so the
// real domain error classes stay intact for the wrapper's `instanceof` checks).
// Asserts: happy path → 200 DTO with the internal `input` field DROPPED; both
// `GroupAccessError` (no access) and `TransactionNotFoundError` (absent / other
// group) → the CONFLATED 404 `not_found`, indistinguishable from each other.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GroupAccessError } from '$lib/server/groups';

const { getTransactionDetail } = vi.hoisted(() => ({ getTransactionDetail: vi.fn() }));
vi.mock('$lib/server/transactions', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/transactions')>();
	return { ...actual, getTransactionDetail };
});

import { GET } from './+server';
import { TransactionNotFoundError } from '$lib/server/transactions';
import type { ApiKeyPrincipal } from '$lib/server/api/principal';

const principal: ApiKeyPrincipal = {
	keyId: 'key_1',
	userId: 'user_1',
	permissions: { api: ['read'] }
};

function makeEvent(gid = 'g1', txid = 't1') {
	const url = new URL(`http://localhost/api/v1/groups/${gid}/transactions/${txid}`);
	return {
		locals: { apiKey: principal },
		url,
		request: new Request(url),
		params: { gid, txid }
	} as unknown as Parameters<typeof GET>[0];
}

async function read(res: Response) {
	return { status: res.status, body: await res.json() };
}

const detail = {
	id: 't1',
	groupId: 'g1',
	type: 'spending' as const,
	title: 'Dinner',
	categoryId: 'food',
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
	shares: [
		{ memberId: 'm1', amountOwed: 4500 },
		{ memberId: 'm2', amountOwed: 4500 }
	],
	items: [],
	charges: [],
	// UI-only edit-form seed that MUST be dropped from the wire.
	input: { type: 'spending', title: 'Dinner', secret: 'internal' }
};

beforeEach(() => vi.clearAllMocks());

describe('GET /api/v1/groups/{gid}/transactions/{txid}', () => {
	it('200 with the detail DTO; forwards { userId, groupId, txnId }; drops `input`', async () => {
		getTransactionDetail.mockResolvedValue(detail);
		const { status, body } = await read((await GET(makeEvent('g1', 't1'))) as Response);
		expect(status).toBe(200);
		expect(getTransactionDetail).toHaveBeenCalledWith({
			userId: 'user_1',
			groupId: 'g1',
			txnId: 't1'
		});
		// Money nested as self-describing `{ amount, currency }`.
		expect(body.amount).toEqual({ amount: 9000, currency: 'THB' });
		expect(body.settlementAmount).toEqual({ amount: 9000, currency: 'THB' });
		expect(body.payers[0].amountPaid).toEqual({ amount: 9000, currency: 'THB' });
		// The internal edit-form seed is gone.
		expect(body).not.toHaveProperty('input');
	});

	it('no access (GroupAccessError) → 404 not_found', async () => {
		getTransactionDetail.mockRejectedValue(new GroupAccessError());
		const { status, body } = await read((await GET(makeEvent())) as Response);
		expect(status).toBe(404);
		expect(body.error.code).toBe('not_found');
	});

	it('absent / other group (TransactionNotFoundError) → identical 404 (conflated)', async () => {
		getTransactionDetail.mockRejectedValue(new GroupAccessError());
		const noAccess = await read((await GET(makeEvent())) as Response);

		getTransactionDetail.mockRejectedValue(new TransactionNotFoundError());
		const missing = await read((await GET(makeEvent())) as Response);

		expect(missing.status).toBe(404);
		// No signal distinguishing "can't see it" from "doesn't exist".
		expect(missing.body).toEqual(noAccess.body);
	});
});
