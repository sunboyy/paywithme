import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isRedirect, isHttpError } from '@sveltejs/kit';

// Route tests for the `[txid]` transaction view/edit page (task 4.11).
//
// Like the `new` route tests, the transaction schema has NESTED ARRAYS that
// superforms only carries over its `dataType: 'json'` envelope — awkward to
// hand-build — so we mock `superValidate` / `setError` and assert the ACTION'S
// BRANCHING contract directly (the real assertions live in
// `server/transactions.test.ts`):
//   - load → getTransactionDetail + a seeded edit form; 404 on not-found.
//   - edit valid → updateTransaction → redirect to the detail page; invalid → 400
//     form failure (NO 500); soft-deleted → setError (no 500); access → 404.
//   - delete → softDeleteTransaction → redirect to the LIST.
//   - restore → restoreTransaction → redirect to the detail page.

const { superValidate, setError } = vi.hoisted(() => ({
	superValidate: vi.fn(),
	setError: vi.fn()
}));
vi.mock('sveltekit-superforms', () => ({ superValidate, setError }));
vi.mock('sveltekit-superforms/adapters', () => ({ zod4: vi.fn(() => ({})) }));

const {
	getTransactionDetail,
	updateTransaction,
	softDeleteTransaction,
	restoreTransaction,
	getGroupForUser,
	listMembers,
	requireGroupAccess,
	requireUser
} = vi.hoisted(() => ({
	getTransactionDetail: vi.fn(),
	updateTransaction: vi.fn(),
	softDeleteTransaction: vi.fn(),
	restoreTransaction: vi.fn(),
	getGroupForUser: vi.fn(),
	listMembers: vi.fn(),
	requireGroupAccess: vi.fn(),
	requireUser: vi.fn()
}));

vi.mock('$lib/server/transactions', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/transactions')>(
		'$lib/server/transactions'
	);
	return {
		...actual,
		getTransactionDetail,
		updateTransaction,
		softDeleteTransaction,
		restoreTransaction
	};
});
vi.mock('$lib/server/groups', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/groups')>('$lib/server/groups');
	return { ...actual, getGroupForUser };
});
vi.mock('$lib/server/members', () => ({ listMembers }));
vi.mock('$lib/server/access', () => ({ requireGroupAccess, requireUser }));

import { load, actions } from './+page.server';
import { GroupAccessError } from '$lib/server/groups';
import {
	TransactionValidationError,
	TransactionNotFoundError,
	TransactionDeletedError
} from '$lib/server/transactions';

type User = { id: string; name: string };

const GROUP = { id: 'g1', name: 'Trip', settlementCurrency: 'THB' };
const MEMBERS = [
	{ id: 'm1', displayName: 'Alice', userId: 'u1', deactivatedAt: null, isLinked: true },
	{ id: 'm2', displayName: 'Bob', userId: null, deactivatedAt: null, isLinked: false }
];

/** The reconstructed input the detail carries (what seeds the edit form). */
function reconstructedInput() {
	return {
		type: 'spending',
		title: 'Dinner',
		categoryId: 'spending-food-drink',
		amountTotal: 9000,
		currency: 'THB',
		exchangeRate: '1',
		amountTotalSettlement: 9000,
		splitMode: 'equal',
		payers: [{ memberId: 'm1', amountPaid: 9000 }],
		beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }],
		items: [],
		charges: []
	};
}

function detailFixture(over: Record<string, unknown> = {}) {
	return {
		id: 't1',
		groupId: 'g1',
		type: 'spending',
		title: 'Dinner',
		categoryId: 'spending-food-drink',
		categoryName: 'Food & Drink',
		categoryIcon: 'utensils',
		amountTotal: 9000,
		currency: 'THB',
		amountTotalSettlement: 9000,
		settlementCurrency: 'THB',
		isForeign: false,
		splitMode: 'equal',
		createdAt: '2026-02-01T00:00:00.000Z',
		deletedAt: null,
		payers: [{ memberId: 'm1', amountPaid: 9000 }],
		shares: [
			{ memberId: 'm1', amountOwed: 4500 },
			{ memberId: 'm2', amountOwed: 4500 }
		],
		items: [],
		charges: [],
		input: reconstructedInput(),
		...over
	};
}

function programForm(opts: { valid: boolean; data?: unknown }) {
	superValidate.mockResolvedValue({
		valid: opts.valid,
		data: opts.data ?? reconstructedInput(),
		errors: {},
		posted: true,
		id: 'tx'
	});
}

function makeLoadEvent(user: User | null) {
	return {
		params: { id: 'g1', txid: 't1' },
		locals: { user, session: user ? {} : null }
	} as unknown as Parameters<typeof load>[0];
}

function makeActionEvent(user: User | null) {
	const request = new Request('http://localhost/groups/g1/transactions/t1', {
		method: 'POST',
		body: new FormData()
	});
	return {
		request,
		params: { id: 'g1', txid: 't1' },
		locals: { user, session: user ? {} : null }
	} as unknown as Parameters<(typeof actions)['edit']>[0];
}

beforeEach(() => {
	superValidate.mockReset();
	setError.mockReset();
	getTransactionDetail.mockReset();
	updateTransaction.mockReset();
	softDeleteTransaction.mockReset();
	restoreTransaction.mockReset();
	getGroupForUser.mockReset();
	listMembers.mockReset();
	requireGroupAccess.mockReset();
	requireUser.mockReset();

	requireGroupAccess.mockResolvedValue({ user: { id: 'u1', name: 'Alice' }, group: GROUP });
	requireUser.mockReturnValue({ id: 'u1', name: 'Alice' });
	getGroupForUser.mockResolvedValue(GROUP);
	listMembers.mockResolvedValue(MEMBERS);
	getTransactionDetail.mockResolvedValue(detailFixture());
	updateTransaction.mockResolvedValue(undefined);
	softDeleteTransaction.mockResolvedValue(undefined);
	restoreTransaction.mockResolvedValue(undefined);
	programForm({ valid: true });
});

describe('/groups/[id]/transactions/[txid] load', () => {
	it('loads the detail + seeds an edit form from the reconstructed input', async () => {
		const result = (await load(makeLoadEvent({ id: 'u1', name: 'Alice' }))) as {
			detail: { id: string; title: string };
			form: unknown;
			members: unknown[];
			memberNames: Record<string, string>;
		};
		expect(getTransactionDetail).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			txnId: 't1'
		});
		expect(result.detail.id).toBe('t1');
		// superValidate was seeded from the reconstructed input.
		expect(superValidate).toHaveBeenCalled();
		expect(superValidate.mock.calls[0][0]).toMatchObject({ title: 'Dinner' });
		expect(result.memberNames.m1).toBe('Alice');
	});

	it('404s when the transaction is not found (existence never leaked)', async () => {
		getTransactionDetail.mockRejectedValueOnce(new TransactionNotFoundError());
		try {
			await load(makeLoadEvent({ id: 'u1', name: 'Alice' }));
			expect.unreachable('expected a 404');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(404);
		}
	});
});

describe('/groups/[id]/transactions/[txid] edit action', () => {
	it('updates the transaction and redirects to the detail page on a valid POST', async () => {
		try {
			await actions.edit(makeActionEvent({ id: 'u1', name: 'Alice' }));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/groups/g1/transactions/t1');
			}
		}
		expect(updateTransaction).toHaveBeenCalledTimes(1);
		const arg = updateTransaction.mock.calls[0][0];
		expect(arg.userId).toBe('u1');
		expect(arg.groupId).toBe('g1');
		expect(arg.txnId).toBe('t1');
		// Settlement currency from the TRUSTED group row, not the payload.
		expect(arg.settlementCurrency).toBe('THB');
	});

	it('returns a 400 form failure (no 500) when the input is invalid', async () => {
		programForm({ valid: false });
		const result = (await actions.edit(makeActionEvent({ id: 'u1', name: 'Alice' }))) as {
			status: number;
			data: { form: { valid: boolean } };
		};
		expect(updateTransaction).not.toHaveBeenCalled();
		expect(result.status).toBe(400);
		expect(result.data.form.valid).toBe(false);
	});

	it('refuses to edit a soft-deleted txn via setError (no 500)', async () => {
		updateTransaction.mockRejectedValueOnce(new TransactionDeletedError());
		setError.mockReturnValue({ status: 400 });
		await actions.edit(makeActionEvent({ id: 'u1', name: 'Alice' }));
		// The deleted error is surfaced as a form-level message, not thrown / 500.
		expect(setError).toHaveBeenCalledWith(
			expect.anything(),
			'',
			expect.stringContaining('deleted')
		);
	});

	it('surfaces a service TransactionValidationError as a 400 form failure (no 500)', async () => {
		updateTransaction.mockRejectedValueOnce(
			new TransactionValidationError([
				{ code: 'custom', path: ['categoryId'], message: 'Unknown category' } as never
			])
		);
		const result = (await actions.edit(makeActionEvent({ id: 'u1', name: 'Alice' }))) as {
			status: number;
		};
		expect(result.status).toBe(400);
		expect(setError).toHaveBeenCalledWith(expect.anything(), 'categoryId', 'Unknown category');
	});

	it('maps a not-found / access error from the service to a 404', async () => {
		updateTransaction.mockRejectedValueOnce(new TransactionNotFoundError());
		try {
			await actions.edit(makeActionEvent({ id: 'u1', name: 'Alice' }));
			expect.unreachable('expected a 404');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(404);
		}
	});

	it('404s when the group is not accessible at action time', async () => {
		getGroupForUser.mockResolvedValueOnce(null);
		try {
			await actions.edit(makeActionEvent({ id: 'u1', name: 'Alice' }));
			expect.unreachable('expected a 404');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(404);
		}
		expect(updateTransaction).not.toHaveBeenCalled();
	});

	it('returns a generic 500 (no leak) on an unexpected service error', async () => {
		updateTransaction.mockRejectedValueOnce(new Error('DB exploded: secret'));
		const result = (await actions.edit(makeActionEvent({ id: 'u1', name: 'Alice' }))) as {
			status: number;
		};
		expect(result.status).toBe(500);
	});
});

describe('/groups/[id]/transactions/[txid] delete action', () => {
	it('soft-deletes and redirects to the LIST', async () => {
		try {
			await actions.delete(makeActionEvent({ id: 'u1', name: 'Alice' }));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/groups/g1/transactions');
			}
		}
		expect(softDeleteTransaction).toHaveBeenCalledTimes(1);
		const arg = softDeleteTransaction.mock.calls[0][0];
		expect(arg.groupId).toBe('g1');
		expect(arg.txnId).toBe('t1');
	});

	it('maps a not-found from the service to a 404', async () => {
		softDeleteTransaction.mockRejectedValueOnce(new TransactionNotFoundError());
		try {
			await actions.delete(makeActionEvent({ id: 'u1', name: 'Alice' }));
			expect.unreachable('expected a 404');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(404);
		}
	});
});

describe('/groups/[id]/transactions/[txid] restore action', () => {
	it('restores and redirects to the detail page', async () => {
		try {
			await actions.restore(makeActionEvent({ id: 'u1', name: 'Alice' }));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/groups/g1/transactions/t1');
			}
		}
		expect(restoreTransaction).toHaveBeenCalledTimes(1);
		const arg = restoreTransaction.mock.calls[0][0];
		expect(arg.txnId).toBe('t1');
	});

	it('maps an access error from the service to a 404', async () => {
		restoreTransaction.mockRejectedValueOnce(new GroupAccessError());
		try {
			await actions.restore(makeActionEvent({ id: 'u1', name: 'Alice' }));
			expect.unreachable('expected a 404');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(404);
		}
	});
});
