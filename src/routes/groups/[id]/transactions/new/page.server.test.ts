import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SEEDED_CURRENCY_DESCRIPTORS } from '$lib/money';
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

const { superValidate, setError, message } = vi.hoisted(() => ({
	superValidate: vi.fn(),
	setError: vi.fn(),
	// The whole-form banner the §7.7 resolve race comes back as. Returns what the
	// real one returns for a status: an ActionFailure-shaped object.
	message: vi.fn((form, msg, opts) => ({ status: opts?.status ?? 200, data: { form, msg } }))
}));
vi.mock('sveltekit-superforms', () => ({ superValidate, setError, message }));
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

// The Capture service (issue #51). The route reads ONE open row for the prefill and
// resolves through `recordCaptureAsTransaction`; the error CLASSES it branches on
// stay real, so `instanceof` means what it means in production.
const { findOpenCapture, recordCaptureAsTransaction } = vi.hoisted(() => ({
	findOpenCapture: vi.fn(),
	recordCaptureAsTransaction: vi.fn()
}));
vi.mock('$lib/server/captures', async () => {
	const actual =
		await vi.importActual<typeof import('$lib/server/captures')>('$lib/server/captures');
	return { ...actual, findOpenCapture, recordCaptureAsTransaction };
});
vi.mock('$lib/server/access', () => ({ requireGroupAccess, requireUser }));

// The group-scoped ENTRY-CURRENCY set (#63; PLAN §7.5.2). The route reads it for
// the picker AND for the group-scoped entry-currency validator; mocked to the
// seeded 29 so these tests exercise the unchanged seeded-currency behaviour.
const { listCurrenciesForGroup } = vi.hoisted(() => ({ listCurrenciesForGroup: vi.fn() }));
vi.mock('$lib/server/currencies', () => ({ listCurrenciesForGroup }));

import { load, actions } from './+page.server';
import { GroupAccessError } from '$lib/server/groups';
import { TransactionValidationError } from '$lib/server/transactions';
import { CaptureNotFoundError, CaptureNotOpenError } from '$lib/server/captures';

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
		locals: { user, session: user ? {} : null },
		// `load` reads `url.searchParams` for the §8.4 settle prefill (task 5.4);
		// a plain new-transaction visit carries no prefill params.
		url: new URL('http://localhost/groups/g1/transactions/new')
	} as unknown as Parameters<typeof load>[0];
}

function makeActionEvent(user: User | null, search = '') {
	const request = new Request(`http://localhost/groups/g1/transactions/new${search}`, {
		method: 'POST',
		body: new FormData()
	});
	return {
		request,
		params: { id: 'g1' },
		locals: { user, session: user ? {} : null },
		url: new URL(request.url)
	} as unknown as Parameters<(typeof actions)['default']>[0];
}

beforeEach(() => {
	superValidate.mockReset();
	listCurrenciesForGroup.mockReset();
	listCurrenciesForGroup.mockResolvedValue(
		SEEDED_CURRENCY_DESCRIPTORS.map((c) => ({ ...c, name: c.displayCode, isCustom: false }))
	);
	setError.mockReset();
	message.mockClear();
	findOpenCapture.mockReset();
	findOpenCapture.mockResolvedValue(null);
	recordCaptureAsTransaction.mockReset();
	recordCaptureAsTransaction.mockResolvedValue('t1');
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

	it('offers the GROUP-SCOPED currency set, custom rows included (§7.5.2)', async () => {
		// The picker and the entry-currency validator read ONE list — the group's own
		// (#61 `listCurrenciesForGroup`), not the compiled-in seeded constant. Each
		// entry carries the `display_code` the picker renders alongside the opaque
		// primary key it posts.
		listCurrenciesForGroup.mockResolvedValue([
			...SEEDED_CURRENCY_DESCRIPTORS.map((c) => ({ ...c, name: c.displayCode, isCustom: false })),
			{
				code: 'cur_beer',
				displayCode: 'BEER',
				symbol: '🍺',
				exponent: 0,
				name: 'Bottle of beer',
				isCustom: true
			}
		]);

		const result = (await load(makeLoadEvent({ id: 'u1', name: 'Alice' }))) as {
			currencies: { code: string; displayCode: string; exponent: number }[];
		};

		expect(listCurrenciesForGroup).toHaveBeenCalledWith({ userId: 'u1', groupId: 'g1' });
		const beer = result.currencies.find((c) => c.code === 'cur_beer');
		expect(beer).toEqual(
			expect.objectContaining({ displayCode: 'BEER', exponent: 0, symbol: '🍺' })
		);
		// Seeded rows still travel with `displayCode === code` (the seeded invariant).
		expect(result.currencies.find((c) => c.code === 'THB')?.displayCode).toBe('THB');
	});
});

describe('/groups/[id]/transactions/new default action', () => {
	it('preserves settle-prefill query state when authentication must resume', async () => {
		const search = '?type=transfer&from=m1&to=m2&amount=1250';
		requireUser.mockImplementationOnce(() => {
			throw new Error('redirect');
		});
		await expect(actions.default(makeActionEvent(null, search))).rejects.toBeDefined();

		expect(requireUser).toHaveBeenCalledWith(expect.objectContaining({ user: null }), {
			redirectTo: '/groups/g1/transactions/new' + search
		});
		expect(createTransaction).not.toHaveBeenCalled();
	});

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

// ── Recording a note from the tray (issue #51; PLAN §7.7 "Resolving") ──────────
// The `?capture=` id is what turns an ordinary save into a RESOLVE: the service
// stamps the note in the same DB transaction as the insert (§12.1). These tests pin
// the action's branching — which service is called, and what each of the two "you
// can't resolve that" endings comes back as.
describe('/groups/[id]/transactions/new default action — recording a note (§7.7)', () => {
	it('resolves through the Capture service when ?capture= is present', async () => {
		try {
			await actions.default(makeActionEvent({ id: 'u1', name: 'Alice' }, '?capture=cap-1'));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
		}

		// ONE write path, not two: the plain create must NOT also run, or the note's
		// stamp would land outside the transaction it names (or not at all).
		expect(createTransaction).not.toHaveBeenCalled();
		expect(recordCaptureAsTransaction).toHaveBeenCalledTimes(1);
		const arg = recordCaptureAsTransaction.mock.calls[0][0];
		expect(arg.captureId).toBe('cap-1');
		expect(arg.userId).toBe('u1');
		expect(arg.groupId).toBe('g1');
		// Trusted group context, exactly as the plain create gets it.
		expect(arg.settlementCurrency).toBe('THB');
		expect(arg.input.title).toBe('Dinner');
	});

	it('saves an ORDINARY transaction when no note is being recorded', async () => {
		try {
			await actions.default(makeActionEvent({ id: 'u1', name: 'Alice' }));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
		}
		expect(recordCaptureAsTransaction).not.toHaveBeenCalled();
		expect(createTransaction).toHaveBeenCalledTimes(1);
	});

	it('validates the prefilled payload like any other — an invalid one never reaches the service', async () => {
		programForm({ valid: false });

		const result = (await actions.default(
			makeActionEvent({ id: 'u1', name: 'Alice' }, '?capture=cap-1')
		)) as { status: number };

		// The prefill is a starting point, not a trusted payload (§7.4).
		expect(result.status).toBe(400);
		expect(recordCaptureAsTransaction).not.toHaveBeenCalled();
		expect(createTransaction).not.toHaveBeenCalled();
	});

	it.each([
		['resolved' as const, 'Someone already recorded that one'],
		['discarded' as const, 'Someone already discarded that one']
	])('reports the %s race as a 409, with nothing saved', async (reason, expected) => {
		recordCaptureAsTransaction.mockRejectedValueOnce(new CaptureNotOpenError(reason));

		const result = (await actions.default(
			makeActionEvent({ id: 'u1', name: 'Alice' }, '?capture=cap-1')
		)) as { status: number };

		// A conflict, not a redirect: the service rolled the whole write back, so
		// claiming success would be a lie — and the filled-in form is kept.
		expect(result.status).toBe(409);
		const [, msg] = message.mock.calls[0];
		expect(msg.type).toBe('error');
		expect(msg.text).toContain(expected);
		// §7.7 naming: the internal word never reaches a user.
		expect(msg.text.toLowerCase()).not.toContain('capture');
	});

	// ── Issue #89: the action must act on what `load` decided ──────────────────
	// `load` degrades a missing / discarded / foreign `?capture=` to null and hands
	// back the ordinary blank form, promising an ordinary save. The action used to
	// break that promise: it read the param unconditionally, so Alice — who opened the
	// tray link a moment after Bob discarded the note — filled in a real transaction
	// and got "nothing was saved" on every single retry.
	it('saves an ORDINARY transaction when the note id no longer resolves', async () => {
		recordCaptureAsTransaction.mockRejectedValueOnce(new CaptureNotFoundError());

		try {
			await actions.default(makeActionEvent({ id: 'u1', name: 'Alice' }, '?capture=gone'));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
		}

		// The user's transaction is saved (the stamp rolled its own attempt back, so
		// nothing was written before this), and no note is stamped.
		expect(createTransaction).toHaveBeenCalledTimes(1);
		expect(createTransaction.mock.calls[0][0].input.title).toBe('Dinner');
	});

	it('stamps nothing when a note id is appended to a settle-up prefill URL', async () => {
		// The settle link (§8.4) never carries a note id, so a hand-built one names an
		// unrelated OPEN note — and `load` seeds the Transfer and ignores it. The action
		// reads the query string through the same decision, so it ignores it too.
		try {
			await actions.default(
				makeActionEvent(
					{ id: 'u1', name: 'Alice' },
					'?type=transfer&from=m2&to=m1&amount=12000&category=transfer-debt-settlement&capture=cap-1'
				)
			);
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
		}

		expect(recordCaptureAsTransaction).not.toHaveBeenCalled();
		expect(createTransaction).toHaveBeenCalledTimes(1);
	});

	it('still records the note when the settle params are not a usable prefill', async () => {
		// `from`/`to` name nobody in this group, so `load` falls through to the note —
		// and so must the action. The two answer this URL the same way or neither is
		// trustworthy.
		try {
			await actions.default(
				makeActionEvent({ id: 'u1', name: 'Alice' }, '?type=transfer&from=nope&to=m1&capture=cap-1')
			);
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
		}

		expect(recordCaptureAsTransaction).toHaveBeenCalledTimes(1);
		expect(recordCaptureAsTransaction.mock.calls[0][0].captureId).toBe('cap-1');
		expect(createTransaction).not.toHaveBeenCalled();
	});

	it('preserves the ?capture= link when authentication must resume', async () => {
		requireUser.mockImplementationOnce(() => {
			throw new Error('redirect');
		});
		await expect(actions.default(makeActionEvent(null, '?capture=cap-1'))).rejects.toBeDefined();

		// Coming back from sign-in must land on the PREFILLED form again, or the note
		// silently stops being resolved by this save.
		expect(requireUser).toHaveBeenCalledWith(expect.objectContaining({ user: null }), {
			redirectTo: '/groups/g1/transactions/new?capture=cap-1'
		});
	});
});
