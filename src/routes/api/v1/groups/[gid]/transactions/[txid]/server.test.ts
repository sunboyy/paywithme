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

const { getTransactionDetail, updateTransaction, softDeleteTransaction } = vi.hoisted(() => ({
	getTransactionDetail: vi.fn(),
	updateTransaction: vi.fn(),
	softDeleteTransaction: vi.fn()
}));
vi.mock('$lib/server/transactions', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/transactions')>();
	return { ...actual, getTransactionDetail, updateTransaction, softDeleteTransaction };
});

import { GET, PUT, DELETE } from './+server';
import {
	TransactionNotFoundError,
	TransactionValidationError,
	TransactionDeletedError
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

function makeEvent(gid = 'g1', txid = 't1') {
	const url = new URL(`http://localhost/api/v1/groups/${gid}/transactions/${txid}`);
	return {
		locals: { apiKey: principal },
		url,
		request: new Request(url),
		params: { gid, txid }
	} as unknown as Parameters<typeof GET>[0];
}

/** A body-bearing mutation event (PUT / DELETE) with a chosen principal + optional raw body. */
function makeMutationEvent(
	method: 'PUT' | 'DELETE',
	body: unknown,
	{
		gid = 'g1',
		txid = 't1',
		apiKey = writePrincipal,
		raw
	}: { gid?: string; txid?: string; apiKey?: ApiKeyPrincipal; raw?: string } = {}
) {
	const url = new URL(`http://localhost/api/v1/groups/${gid}/transactions/${txid}`);
	const request = new Request(url, {
		method,
		...(method === 'PUT'
			? { headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body) }
			: {})
	});
	return {
		locals: { apiKey },
		url,
		request,
		params: { gid, txid }
	} as unknown as Parameters<typeof PUT>[0];
}

const validInput = {
	type: 'spending',
	title: 'Dinner (edited)',
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

describe('PUT /api/v1/groups/{gid}/transactions/{txid}', () => {
	it('happy path → 200 with the replaced detail DTO; forwards the full input; drops `input`', async () => {
		updateTransaction.mockResolvedValue(undefined);
		getTransactionDetail.mockResolvedValue(detail);

		const { status, body } = await read(
			(await PUT(makeMutationEvent('PUT', validInput))) as Response
		);
		expect(status).toBe(200);
		expect(updateTransaction).toHaveBeenCalledWith({
			userId: 'user_1',
			groupId: 'g1',
			txnId: 't1',
			input: validInput,
			actorUserId: 'user_1'
		});
		expect(body.amount).toEqual({ amount: 9000, currency: 'THB' });
		expect(body).not.toHaveProperty('input');
	});

	it('read key → 403 forbidden_scope; the service is never called', async () => {
		const { status, body } = await read(
			(await PUT(makeMutationEvent('PUT', validInput, { apiKey: principal }))) as Response
		);
		expect(status).toBe(403);
		expect(body.error.code).toBe('forbidden_scope');
		expect(updateTransaction).not.toHaveBeenCalled();
	});

	it('amountTotalSettlement mismatch → 422 with field-level details', async () => {
		updateTransaction.mockRejectedValue(
			new TransactionValidationError([
				{
					code: 'custom',
					path: ['amountTotalSettlement'],
					message: 'The settlement total must equal the converted transaction total'
				} as never
			])
		);
		const { status, body } = await read(
			(await PUT(makeMutationEvent('PUT', { ...validInput, amountTotalSettlement: 1 }))) as Response
		);
		expect(status).toBe(422);
		expect(body.error.code).toBe('validation_error');
		expect(body.error.details.fieldErrors.amountTotalSettlement).toEqual([
			'The settlement total must equal the converted transaction total'
		]);
	});

	it('editing a soft-deleted txn (TransactionDeletedError) → 422 validation_error', async () => {
		updateTransaction.mockRejectedValue(new TransactionDeletedError());
		const { status, body } = await read(
			(await PUT(makeMutationEvent('PUT', validInput))) as Response
		);
		expect(status).toBe(422);
		expect(body.error.code).toBe('validation_error');
		expect(body.error.message).toMatch(/restore/i);
	});

	it('unparseable JSON body → 400 bad_request', async () => {
		const { status, body } = await read(
			(await PUT(makeMutationEvent('PUT', null, { raw: '{not json' }))) as Response
		);
		expect(status).toBe(400);
		expect(body.error.code).toBe('bad_request');
		expect(updateTransaction).not.toHaveBeenCalled();
	});

	it('absent / no access → 404 not_found (conflated)', async () => {
		updateTransaction.mockRejectedValue(new TransactionNotFoundError());
		const { status, body } = await read(
			(await PUT(makeMutationEvent('PUT', validInput))) as Response
		);
		expect(status).toBe(404);
		expect(body.error.code).toBe('not_found');
	});
});

describe('DELETE /api/v1/groups/{gid}/transactions/{txid}', () => {
	const deletedDetail = { ...detail, deletedAt: '2026-01-03T10:00:00.000Z' };

	it('happy path → 200 with the detail DTO carrying `deletedAt` set', async () => {
		softDeleteTransaction.mockResolvedValue(undefined);
		getTransactionDetail.mockResolvedValue(deletedDetail);

		const { status, body } = await read(
			(await DELETE(makeMutationEvent('DELETE', null))) as Response
		);
		expect(status).toBe(200);
		expect(softDeleteTransaction).toHaveBeenCalledWith({
			userId: 'user_1',
			groupId: 'g1',
			txnId: 't1',
			actorUserId: 'user_1'
		});
		expect(body.deletedAt).toBe('2026-01-03T10:00:00.000Z');
	});

	it('read key → 403 forbidden_scope; the service is never called', async () => {
		const { status, body } = await read(
			(await DELETE(makeMutationEvent('DELETE', null, { apiKey: principal }))) as Response
		);
		expect(status).toBe(403);
		expect(body.error.code).toBe('forbidden_scope');
		expect(softDeleteTransaction).not.toHaveBeenCalled();
	});

	it('absent / no access → 404 not_found (conflated)', async () => {
		softDeleteTransaction.mockRejectedValue(new TransactionNotFoundError());
		const { status, body } = await read(
			(await DELETE(makeMutationEvent('DELETE', null))) as Response
		);
		expect(status).toBe(404);
		expect(body.error.code).toBe('not_found');
	});
});
