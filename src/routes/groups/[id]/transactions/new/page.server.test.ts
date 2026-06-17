import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isRedirect, isHttpError } from '@sveltejs/kit';

// Route tests for the `new` transaction page (task 4.7).
//
// The transaction schema has NESTED ARRAYS (payers / beneficiaries), which
// superforms only carries over its `dataType: 'json'` devalue envelope — awkward
// to hand-build in a unit test. So we mock `superValidate` / `setError` from
// `sveltekit-superforms` to return a PROGRAMMED form, and assert the ACTION'S
// branching contract directly (the schema itself is covered by
// `schemas/transaction.test.ts` and the service by `server/transactions.test.ts`):
//   - valid → createTransaction(trusted settlement currency + form data) → redirect
//     to the list;
//   - invalid → a 400 form failure (NOT a 500);
//   - service GroupAccessError / no group at action time → 404.

const { superValidate, setError } = vi.hoisted(() => ({
	superValidate: vi.fn(),
	setError: vi.fn()
}));
vi.mock('sveltekit-superforms', () => ({ superValidate, setError }));
vi.mock('sveltekit-superforms/adapters', () => ({ zod4: vi.fn(() => ({})) }));

const { createTransaction, getGroupForUser, listMembers, requireGroupAccess, requireUser } =
	vi.hoisted(() => ({
		createTransaction: vi.fn(),
		getGroupForUser: vi.fn(),
		listMembers: vi.fn(),
		requireGroupAccess: vi.fn(),
		requireUser: vi.fn()
	}));

vi.mock('$lib/server/transactions', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/transactions')>(
		'$lib/server/transactions'
	);
	return { ...actual, createTransaction };
});
vi.mock('$lib/server/groups', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/groups')>('$lib/server/groups');
	return { ...actual, getGroupForUser };
});
vi.mock('$lib/server/members', () => ({ listMembers }));
vi.mock('$lib/server/access', () => ({ requireGroupAccess, requireUser }));

import { load, actions } from './+page.server';
import { GroupAccessError } from '$lib/server/groups';
import { TransactionValidationError } from '$lib/server/transactions';

type User = { id: string; name: string };

const GROUP = { id: 'g1', name: 'Trip', settlementCurrency: 'THB' };
const MEMBERS = [
	{ id: 'm1', displayName: 'Alice', userId: 'u1', deactivatedAt: null, isLinked: true },
	{ id: 'm2', displayName: 'Bob', userId: null, deactivatedAt: null, isLinked: false }
];

/** A valid equal-split spending payload (what the validated form carries). */
function validData() {
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

/** A valid ITEMIZED spending payload (task 4.8) — items only, no charges. */
function validItemizedData() {
	return {
		type: 'spending',
		title: 'Group dinner',
		categoryId: 'spending-food-drink',
		amountTotal: 110,
		currency: 'THB',
		exchangeRate: '1',
		amountTotalSettlement: 110,
		splitMode: 'itemized',
		payers: [{ memberId: 'm1', amountPaid: 110 }],
		beneficiaries: [],
		items: [
			{
				label: 'Pizza',
				amount: 100,
				splitMode: 'equal',
				beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }]
			},
			{
				label: 'Wine',
				amount: 10,
				splitMode: 'share',
				beneficiaries: [
					{ memberId: 'm1', shareWeight: 1 },
					{ memberId: 'm2', shareWeight: 2 }
				]
			}
		],
		charges: []
	};
}

/** Program `superValidate` to return a form with the given validity/data. */
function programForm(opts: { valid: boolean; data?: unknown }) {
	superValidate.mockResolvedValue({
		valid: opts.valid,
		data: opts.data ?? validData(),
		errors: {},
		posted: true,
		id: 'tx'
	});
}

function makeLoadEvent(user: User | null) {
	return {
		params: { id: 'g1' },
		locals: { user, session: user ? {} : null }
	} as unknown as Parameters<typeof load>[0];
}

function makeActionEvent(user: User | null) {
	const request = new Request('http://localhost/groups/g1/transactions/new', {
		method: 'POST',
		body: new FormData()
	});
	return {
		request,
		params: { id: 'g1' },
		locals: { user, session: user ? {} : null }
	} as unknown as Parameters<(typeof actions)['default']>[0];
}

beforeEach(() => {
	superValidate.mockReset();
	setError.mockReset();
	createTransaction.mockReset();
	getGroupForUser.mockReset();
	listMembers.mockReset();
	requireGroupAccess.mockReset();
	requireUser.mockReset();

	requireGroupAccess.mockResolvedValue({ user: { id: 'u1', name: 'Alice' }, group: GROUP });
	requireUser.mockReturnValue({ id: 'u1', name: 'Alice' });
	getGroupForUser.mockResolvedValue(GROUP);
	listMembers.mockResolvedValue(MEMBERS);
	createTransaction.mockResolvedValue('t1');
	programForm({ valid: true });
});

describe('/groups/[id]/transactions/new load', () => {
	it('seeds members + categories + currency + the viewer default payer', async () => {
		const result = (await load(makeLoadEvent({ id: 'u1', name: 'Alice' }))) as {
			members: unknown[];
			categories: { spending: unknown[]; transfer: unknown[] };
			currency: { code: string };
			viewerMemberId: string | null;
		};
		expect(result.viewerMemberId).toBe('m1');
		expect(result.members).toHaveLength(2);
		expect(result.categories.spending.length).toBeGreaterThan(0);
		expect(result.currency.code).toBe('THB');
	});
});

describe('/groups/[id]/transactions/new default action', () => {
	it('creates the transaction and redirects to the list on a valid POST', async () => {
		try {
			await actions.default(makeActionEvent({ id: 'u1', name: 'Alice' }));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/groups/g1/transactions');
			}
		}
		expect(createTransaction).toHaveBeenCalledTimes(1);
		const arg = createTransaction.mock.calls[0][0];
		expect(arg.userId).toBe('u1');
		expect(arg.groupId).toBe('g1');
		// The settlement currency comes from the TRUSTED group row, not the payload.
		expect(arg.settlementCurrency).toBe('THB');
		expect(arg.input.title).toBe('Dinner');
	});

	it('forwards a valid ITEMIZED payload (items, no top-level beneficiaries) to the service', async () => {
		programForm({ valid: true, data: validItemizedData() });
		try {
			await actions.default(makeActionEvent({ id: 'u1', name: 'Alice' }));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
		}
		expect(createTransaction).toHaveBeenCalledTimes(1);
		const arg = createTransaction.mock.calls[0][0];
		// Settlement currency is the trusted group row; the itemized items pass through.
		expect(arg.settlementCurrency).toBe('THB');
		expect(arg.input.splitMode).toBe('itemized');
		expect(arg.input.items).toHaveLength(2);
		expect(arg.input.beneficiaries).toHaveLength(0);
	});

	it('returns a 400 form failure (no 500) when the input is invalid', async () => {
		programForm({ valid: false });
		const result = (await actions.default(makeActionEvent({ id: 'u1', name: 'Alice' }))) as {
			status: number;
			data: { form: { valid: boolean } };
		};

		expect(createTransaction).not.toHaveBeenCalled();
		expect(result.status).toBe(400);
		expect(result.data.form.valid).toBe(false);
	});

	it('surfaces a service TransactionValidationError as a 400 form failure (no 500)', async () => {
		createTransaction.mockRejectedValueOnce(
			new TransactionValidationError([
				{ code: 'custom', path: ['categoryId'], message: 'Unknown category' } as never
			])
		);
		const result = (await actions.default(makeActionEvent({ id: 'u1', name: 'Alice' }))) as {
			status: number;
		};
		expect(result.status).toBe(400);
		// The issue was mapped onto the form via setError.
		expect(setError).toHaveBeenCalledWith(expect.anything(), 'categoryId', 'Unknown category');
	});

	it('maps a GroupAccessError from the service to a 404', async () => {
		createTransaction.mockRejectedValueOnce(new GroupAccessError());
		try {
			await actions.default(makeActionEvent({ id: 'u1', name: 'Alice' }));
			expect.unreachable('expected a 404');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(404);
		}
	});

	it('404s when the group is not accessible at action time', async () => {
		getGroupForUser.mockResolvedValueOnce(null);
		try {
			await actions.default(makeActionEvent({ id: 'u1', name: 'Alice' }));
			expect.unreachable('expected a 404');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(404);
		}
		expect(createTransaction).not.toHaveBeenCalled();
	});

	it('returns a generic 500 (no leak) when the service throws an unexpected error', async () => {
		createTransaction.mockRejectedValueOnce(new Error('DB exploded: secret'));
		const result = (await actions.default(makeActionEvent({ id: 'u1', name: 'Alice' }))) as {
			status: number;
		};
		expect(result.status).toBe(500);
	});
});
