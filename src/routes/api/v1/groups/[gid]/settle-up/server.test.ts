// Unit test for POST /api/v1/groups/{gid}/settle-up (PLAN §16.4, §16.5, §8.4).
//
// HTTP-boundary test with a REAL principal + the REAL `toTransactionDetailDto`
// mapper. `getGroupForUser` (settlement currency source), `createTransaction` (the
// delegated create path), and `getTransactionDetail` (the 201 re-read) are
// overridden via `importOriginal` so the real domain error classes stay intact.
// Asserts: settle-up builds the correct single-payer Transfer (rate 1, "Debt
// settlement", currency = settlement) and delegates to createTransaction; read key →
// 403; a bad body (self-settlement / non-positive amount) → 422 with field details;
// unparseable JSON → 400; a group the key can't see → the CONFLATED 404; an unknown
// member (service TransactionValidationError) → 422.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getGroupForUser } = vi.hoisted(() => ({ getGroupForUser: vi.fn() }));
vi.mock('$lib/server/groups', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/groups')>();
	return { ...actual, getGroupForUser };
});

const { createTransaction, getTransactionDetail } = vi.hoisted(() => ({
	createTransaction: vi.fn(),
	getTransactionDetail: vi.fn()
}));
vi.mock('$lib/server/transactions', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/transactions')>();
	return { ...actual, createTransaction, getTransactionDetail };
});

import { POST } from './+server';
import { TransactionValidationError } from '$lib/server/transactions';
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

function makeEvent(
	body: unknown,
	{
		apiKey = writePrincipal,
		gid = 'g1',
		raw
	}: { apiKey?: ApiKeyPrincipal; gid?: string; raw?: string } = {}
) {
	const url = new URL(`http://localhost/api/v1/groups/${gid}/settle-up`);
	const request = new Request(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: raw ?? JSON.stringify(body)
	});
	return {
		locals: { apiKey },
		url,
		request,
		params: { gid }
	} as unknown as Parameters<typeof POST>[0];
}

async function read(res: Response) {
	return { status: res.status, body: await res.json() };
}

const group = { id: 'g1', name: 'Trip', settlementCurrency: 'THB' };

const transferDetail = {
	id: 't_settle',
	groupId: 'g1',
	type: 'transfer' as const,
	title: 'Debt settlement',
	categoryId: 'transfer-debt-settlement',
	categoryName: 'Debt settlement',
	categoryIcon: 'handshake',
	amountTotal: 5000,
	currency: 'THB' as const,
	amountTotalSettlement: 5000,
	settlementCurrency: 'THB' as const,
	isForeign: false,
	splitMode: 'equal' as const,
	createdAt: '2026-01-02T12:00:00.000Z',
	deletedAt: null,
	payers: [{ memberId: 'm1', amountPaid: 5000 }],
	shares: [{ memberId: 'm2', amountOwed: 5000 }],
	items: [],
	charges: [],
	input: { type: 'transfer', title: 'Debt settlement', secret: 'internal' }
};

beforeEach(() => vi.clearAllMocks());

describe('POST /api/v1/groups/{gid}/settle-up', () => {
	it('builds a single-payer Transfer (rate 1, "Debt settlement") and → 201', async () => {
		getGroupForUser.mockResolvedValue(group);
		createTransaction.mockResolvedValue('t_settle');
		getTransactionDetail.mockResolvedValue(transferDetail);

		const { status, body } = await read(
			(await POST(makeEvent({ from: 'm1', to: 'm2', amount: 5000 }))) as Response
		);
		expect(status).toBe(201);

		// The delegated create input is the single-payer / single-beneficiary transfer.
		const arg = createTransaction.mock.calls[0][0];
		expect(arg.userId).toBe('user_1');
		expect(arg.groupId).toBe('g1');
		// Settlement currency is loaded from the group row, not the payload.
		expect(arg.settlementCurrency).toBe('THB');
		expect(arg.input).toMatchObject({
			type: 'transfer',
			title: 'Debt settlement',
			categoryId: 'transfer-debt-settlement',
			amountTotal: 5000,
			currency: 'THB',
			exchangeRate: '1',
			amountTotalSettlement: 5000,
			splitMode: 'equal',
			payers: [{ memberId: 'm1', amountPaid: 5000 }],
			beneficiaries: [{ memberId: 'm2' }]
		});
		// Response is the TransactionDetail DTO (internal `input` dropped).
		expect(body.type).toBe('transfer');
		expect(body.settlementAmount).toEqual({ amount: 5000, currency: 'THB' });
		expect(body).not.toHaveProperty('input');
	});

	it('read key → 403 forbidden_scope; nothing is loaded or created', async () => {
		const { status, body } = await read(
			(await POST(
				makeEvent({ from: 'm1', to: 'm2', amount: 5000 }, { apiKey: readPrincipal })
			)) as Response
		);
		expect(status).toBe(403);
		expect(body.error.code).toBe('forbidden_scope');
		expect(getGroupForUser).not.toHaveBeenCalled();
		expect(createTransaction).not.toHaveBeenCalled();
	});

	it('self-settlement (from === to) → 422 with field-level details', async () => {
		const { status, body } = await read(
			(await POST(makeEvent({ from: 'm1', to: 'm1', amount: 5000 }))) as Response
		);
		expect(status).toBe(422);
		expect(body.error.code).toBe('validation_error');
		expect(body.error.details.fieldErrors.to).toBeDefined();
		expect(createTransaction).not.toHaveBeenCalled();
	});

	it('non-positive amount → 422 with field-level details', async () => {
		const { status, body } = await read(
			(await POST(makeEvent({ from: 'm1', to: 'm2', amount: 0 }))) as Response
		);
		expect(status).toBe(422);
		expect(body.error.code).toBe('validation_error');
		expect(body.error.details.fieldErrors.amount).toBeDefined();
	});

	it('unparseable JSON body → 400 bad_request', async () => {
		const { status, body } = await read(
			(await POST(makeEvent(null, { raw: '{not json' }))) as Response
		);
		expect(status).toBe(400);
		expect(body.error.code).toBe('bad_request');
		expect(createTransaction).not.toHaveBeenCalled();
	});

	it('group the key cannot see → 404 not_found (conflated)', async () => {
		getGroupForUser.mockResolvedValue(null);
		const { status, body } = await read(
			(await POST(makeEvent({ from: 'm1', to: 'm2', amount: 5000 }))) as Response
		);
		expect(status).toBe(404);
		expect(body.error.code).toBe('not_found');
		expect(createTransaction).not.toHaveBeenCalled();
	});

	it('unknown member (service TransactionValidationError) → 422 with field details', async () => {
		getGroupForUser.mockResolvedValue(group);
		createTransaction.mockRejectedValue(
			new TransactionValidationError([
				{
					code: 'custom',
					path: ['payers'],
					message: 'A selected member is not part of this group'
				} as never
			])
		);
		const { status, body } = await read(
			(await POST(makeEvent({ from: 'mX', to: 'm2', amount: 5000 }))) as Response
		);
		expect(status).toBe(422);
		expect(body.error.code).toBe('validation_error');
		expect(body.error.details.fieldErrors.payers).toBeDefined();
	});
});
