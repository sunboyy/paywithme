import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isRedirect, isHttpError } from '@sveltejs/kit';

// Tests for the `/groups/[id]/settings/currencies` server logic (issue #62;
// PLAN §7.5.2, §10; ADR-0014).
//
// STRATEGY (mirrors `members/page.server.test.ts`): the group / currency services
// are mocked so nothing touches a DB; the tests assert the ROUTE's contract —
//   - the auth guard and the §12 access→404 mapping;
//   - validation failures never reach the service, and land on the RIGHT FIELD;
//   - a create and an edit ROUND-TRIP: what the form posts is what the service
//     receives, normalized by the shared schema;
//   - every #61 service error becomes something the form can render (a field
//     error / a message), never a 500 and never a crash.
//
// The read-only-once-referenced RENDERING is a component concern and is asserted
// in `mount.svelte.test.ts`; what belongs here is that the server still refuses a
// frozen change and says which field froze.

const {
	getGroupForUser,
	userHasGroupAccess,
	listCustomCurrenciesWithUsage,
	createCustomCurrency,
	updateCustomCurrency,
	deleteCustomCurrency,
	GroupAccessError,
	DuplicateDisplayCodeError,
	CurrencyImmutableError,
	CurrencyInUseError,
	CurrencyNotFoundError
} = vi.hoisted(() => {
	class GroupAccessError extends Error {
		readonly code = 'group_access' as const;
	}
	class DuplicateDisplayCodeError extends Error {
		readonly code = 'duplicate_display_code' as const;
		constructor(
			readonly displayCode: string,
			readonly conflictsWith: 'seeded' | 'custom'
		) {
			super(
				conflictsWith === 'seeded'
					? `${displayCode} is already a supported currency — choose it from the list instead`
					: `This group already has a currency with the code ${displayCode}`
			);
		}
	}
	class CurrencyImmutableError extends Error {
		readonly code = 'currency_immutable' as const;
		constructor(
			readonly displayCode: string,
			readonly fields: readonly ('displayCode' | 'exponent')[]
		) {
			super(`${displayCode} is used by at least one transaction`);
		}
	}
	class CurrencyInUseError extends Error {
		readonly code = 'currency_in_use' as const;
		constructor(readonly displayCode: string) {
			super(`${displayCode} is used by at least one transaction and cannot be deleted`);
		}
	}
	class CurrencyNotFoundError extends Error {
		readonly code = 'currency_not_found' as const;
	}
	return {
		getGroupForUser: vi.fn(),
		userHasGroupAccess: vi.fn(),
		listCustomCurrenciesWithUsage: vi.fn(),
		createCustomCurrency: vi.fn(),
		updateCustomCurrency: vi.fn(),
		deleteCustomCurrency: vi.fn(),
		GroupAccessError,
		DuplicateDisplayCodeError,
		CurrencyImmutableError,
		CurrencyInUseError,
		CurrencyNotFoundError
	};
});

vi.mock('$lib/server/groups', () => ({ getGroupForUser, userHasGroupAccess, GroupAccessError }));
vi.mock('$lib/server/currencies', () => ({
	createCustomCurrency,
	updateCustomCurrency,
	deleteCustomCurrency,
	DuplicateDisplayCodeError,
	CurrencyImmutableError,
	CurrencyInUseError,
	CurrencyNotFoundError
}));
vi.mock('$lib/server/currency-usage', () => ({ listCustomCurrenciesWithUsage }));

import { load, actions } from './+page.server';

type User = { id: string; name: string };
const AUTH_USER: User = { id: 'u1', name: 'Alice' };

const BEER = {
	code: 'cur_beer',
	displayCode: 'BEER',
	name: 'Bottle of beer',
	symbol: '🍺',
	exponent: 0,
	isReferenced: false
};

function makeLoadEvent(user: User | null, id = 'g1') {
	return {
		params: { id },
		locals: { user, session: user ? {} : null },
		url: new URL(`http://localhost/groups/${id}/settings/currencies`)
	} as unknown as Parameters<typeof load>[0];
}

function makeActionEvent(fields: Record<string, string>, user: User | null, id = 'g1') {
	const request = new Request(`http://localhost/groups/${id}/settings/currencies`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(fields).toString()
	});
	return {
		request,
		params: { id },
		locals: { user, session: user ? {} : null }
	} as unknown as Parameters<(typeof actions)['create']>[0];
}

/** The superForm payload an action returns, whether it succeeded or failed. */
type ActionForm = {
	valid: boolean;
	errors: Record<string, string[]>;
	message?: { type: string; text: string };
};
type ActionResult = { status?: number; form?: ActionForm; data?: { form: ActionForm } };
function formOf(result: unknown) {
	const r = result as ActionResult;
	return r.data?.form ?? r.form!;
}

beforeEach(() => {
	getGroupForUser.mockReset();
	userHasGroupAccess.mockReset();
	listCustomCurrenciesWithUsage.mockReset();
	createCustomCurrency.mockReset();
	updateCustomCurrency.mockReset();
	deleteCustomCurrency.mockReset();
	getGroupForUser.mockResolvedValue({ id: 'g1', name: 'Trip', settlementCurrency: 'THB' });
	listCustomCurrenciesWithUsage.mockResolvedValue([]);
});

describe('/groups/[id]/settings/currencies load', () => {
	it('redirects an anonymous user to /login and never reads the group', async () => {
		try {
			await load(makeLoadEvent(null));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
		}
		expect(getGroupForUser).not.toHaveBeenCalled();
	});

	it('throws error(404) when the group is not accessible', async () => {
		getGroupForUser.mockResolvedValueOnce(null);
		try {
			await load(makeLoadEvent(AUTH_USER));
			expect.unreachable('expected a 404');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(404);
		}
		expect(listCustomCurrenciesWithUsage).not.toHaveBeenCalled();
	});

	it("returns the group's custom currencies, the settlement currency and three seeded forms", async () => {
		listCustomCurrenciesWithUsage.mockResolvedValueOnce([{ ...BEER, isReferenced: true }]);

		const result = (await load(makeLoadEvent(AUTH_USER))) as {
			group: { id: string; name: string };
			settlement: { displayCode: string; name: string; symbol: string };
			currencies: { code: string; displayCode: string; isReferenced: boolean }[];
			createForm: { data: { exponent: number } };
			editForm: unknown;
			deleteForm: unknown;
		};

		expect(listCustomCurrenciesWithUsage).toHaveBeenCalledWith({ userId: 'u1', groupId: 'g1' });
		expect(result.group).toMatchObject({ id: 'g1', name: 'Trip' });
		// The notice needs the settlement currency BY NAME, resolved from the seeded data.
		expect(result.settlement).toEqual({ displayCode: 'THB', name: 'Thai Baht', symbol: '฿' });
		expect(result.currencies).toEqual([
			{
				code: 'cur_beer',
				displayCode: 'BEER',
				name: 'Bottle of beer',
				symbol: '🍺',
				exponent: 0,
				isReferenced: true
			}
		]);
		// Three structurally distinct forms → three distinct superForms client-side.
		expect(result.createForm.data.exponent).toBe(2);
		expect(result.editForm).toBeDefined();
		expect(result.deleteForm).toBeDefined();
	});

	it('degrades to an empty list when the usage read throws a generic error', async () => {
		listCustomCurrenciesWithUsage.mockRejectedValueOnce(new Error('backend down'));

		const result = (await load(makeLoadEvent(AUTH_USER))) as { currencies: unknown[] };
		expect(result.currencies).toEqual([]);
	});

	it('re-surfaces a racing access failure from the usage read as 404', async () => {
		listCustomCurrenciesWithUsage.mockRejectedValueOnce(new GroupAccessError());
		try {
			await load(makeLoadEvent(AUTH_USER));
			expect.unreachable('expected a 404');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(404);
		}
	});
});

describe('?/create action', () => {
	const VALID = { displayCode: 'beer', name: 'Bottle of beer', symbol: '🍺', exponent: '0' };

	it('redirects anonymous to /login and never calls the service', async () => {
		try {
			await actions.create(makeActionEvent(VALID, null));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
		}
		expect(createCustomCurrency).not.toHaveBeenCalled();
	});

	it('round-trips a valid create: normalized input reaches the service', async () => {
		createCustomCurrency.mockResolvedValueOnce({ code: 'cur_x' });

		const result = await actions.create(makeActionEvent(VALID, AUTH_USER));

		expect(createCustomCurrency).toHaveBeenCalledTimes(1);
		expect(createCustomCurrency).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			// `beer` arrives UPPERCASED — the shared schema normalizes, so the form and
			// the service can never disagree about what was stored.
			input: { displayCode: 'BEER', name: 'Bottle of beer', symbol: '🍺', exponent: 0 }
		});
		expect(formOf(result).message?.type).toBe('success');
	});

	it('fails validation on the CODE field for a blank code, without calling the service', async () => {
		const result = await actions.create(
			makeActionEvent({ ...VALID, displayCode: '   ' }, AUTH_USER)
		);

		expect((result as ActionResult).status).toBe(400);
		const form = formOf(result);
		expect(form.valid).toBe(false);
		expect(form.errors.displayCode?.length).toBeTruthy();
		expect(form.errors.name).toBeUndefined();
		expect(createCustomCurrency).not.toHaveBeenCalled();
	});

	it('fails validation on the DECIMAL PLACES field when it is out of range', async () => {
		const result = await actions.create(makeActionEvent({ ...VALID, exponent: '7' }, AUTH_USER));

		expect((result as ActionResult).status).toBe(400);
		const form = formOf(result);
		expect(form.errors.exponent?.length).toBeTruthy();
		expect(form.errors.displayCode).toBeUndefined();
		expect(createCustomCurrency).not.toHaveBeenCalled();
	});

	it('renders a seeded-code clash as an error on the code field, not a crash', async () => {
		// PLAN §7.5.2: a display code may not shadow one of the seeded 29.
		createCustomCurrency.mockRejectedValueOnce(new DuplicateDisplayCodeError('USD', 'seeded'));

		const result = await actions.create(
			makeActionEvent({ ...VALID, displayCode: 'USD' }, AUTH_USER)
		);

		expect((result as ActionResult).status).toBe(400);
		const form = formOf(result);
		expect(form.errors.displayCode?.join(' ')).toContain('already a supported currency');
		expect(form.errors.name).toBeUndefined();
	});

	it("renders a clash with the group's own code on the code field", async () => {
		createCustomCurrency.mockRejectedValueOnce(new DuplicateDisplayCodeError('BEER', 'custom'));

		const result = await actions.create(makeActionEvent(VALID, AUTH_USER));

		const form = formOf(result);
		expect(form.errors.displayCode?.join(' ')).toContain('already has a currency');
	});

	it('maps a GroupAccessError to error(404)', async () => {
		createCustomCurrency.mockRejectedValueOnce(new GroupAccessError());
		try {
			await actions.create(makeActionEvent(VALID, AUTH_USER));
			expect.unreachable('expected a 404');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(404);
		}
	});

	it('surfaces an unexpected failure as a form message, not a thrown 500', async () => {
		createCustomCurrency.mockRejectedValueOnce(new Error('boom'));

		const result = await actions.create(makeActionEvent(VALID, AUTH_USER));
		expect(formOf(result).message?.type).toBe('error');
	});
});

describe('?/edit action', () => {
	const VALID = {
		code: 'cur_beer',
		displayCode: 'BEER',
		name: 'Large beer',
		symbol: '🍺',
		exponent: '0'
	};

	it('round-trips an edit: the opaque code targets the row, the four fields are the input', async () => {
		updateCustomCurrency.mockResolvedValueOnce({ code: 'cur_beer' });

		const result = await actions.edit(makeActionEvent(VALID, AUTH_USER));

		expect(updateCustomCurrency).toHaveBeenCalledTimes(1);
		expect(updateCustomCurrency).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			code: 'cur_beer',
			// `code` is the target, never part of the patch.
			input: { displayCode: 'BEER', name: 'Large beer', symbol: '🍺', exponent: 0 }
		});
		expect(formOf(result).message?.type).toBe('success');
	});

	it('fails validation on the NAME field for a blank name, without calling the service', async () => {
		const result = await actions.edit(makeActionEvent({ ...VALID, name: '' }, AUTH_USER));

		expect((result as ActionResult).status).toBe(400);
		const form = formOf(result);
		expect(form.errors.name?.length).toBeTruthy();
		expect(form.errors.symbol).toBeUndefined();
		expect(updateCustomCurrency).not.toHaveBeenCalled();
	});

	it('marks EXACTLY the frozen fields when the service refuses an immutable change', async () => {
		// ADR-0014 decision 5 — reachable when the first transaction lands between
		// `load` and the save (the read-only rendering is advisory, the lock is not).
		updateCustomCurrency.mockRejectedValueOnce(
			new CurrencyImmutableError('BEER', ['displayCode', 'exponent'])
		);

		const result = await actions.edit(makeActionEvent(VALID, AUTH_USER));

		expect((result as ActionResult).status).toBe(400);
		const form = formOf(result);
		expect(form.errors.displayCode?.length).toBeTruthy();
		expect(form.errors.exponent?.length).toBeTruthy();
		// `name` / `symbol` never freeze, so they must stay unmarked.
		expect(form.errors.name).toBeUndefined();
		expect(form.errors.symbol).toBeUndefined();
	});

	it('marks only the exponent when only the exponent is frozen', async () => {
		updateCustomCurrency.mockRejectedValueOnce(new CurrencyImmutableError('BEER', ['exponent']));

		const form = formOf(await actions.edit(makeActionEvent(VALID, AUTH_USER)));
		expect(form.errors.exponent?.length).toBeTruthy();
		expect(form.errors.displayCode).toBeUndefined();
	});

	it('renders a duplicate display code on the code field', async () => {
		updateCustomCurrency.mockRejectedValueOnce(new DuplicateDisplayCodeError('THB', 'seeded'));

		const form = formOf(await actions.edit(makeActionEvent(VALID, AUTH_USER)));
		expect(form.errors.displayCode?.length).toBeTruthy();
	});

	it('maps CurrencyNotFoundError to error(404)', async () => {
		updateCustomCurrency.mockRejectedValueOnce(new CurrencyNotFoundError());
		try {
			await actions.edit(makeActionEvent(VALID, AUTH_USER));
			expect.unreachable('expected a 404');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(404);
		}
	});
});

describe('?/delete action', () => {
	it('deletes the targeted row and reports success', async () => {
		deleteCustomCurrency.mockResolvedValueOnce(undefined);

		const result = await actions.delete(makeActionEvent({ code: 'cur_beer' }, AUTH_USER));

		expect(deleteCustomCurrency).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			code: 'cur_beer'
		});
		expect(formOf(result).message?.type).toBe('success');
	});

	it('explains why a referenced currency cannot be deleted instead of failing opaquely', async () => {
		deleteCustomCurrency.mockRejectedValueOnce(new CurrencyInUseError('BEER'));

		const result = await actions.delete(makeActionEvent({ code: 'cur_beer' }, AUTH_USER));

		expect((result as ActionResult).status).toBe(400);
		const form = formOf(result);
		expect(form.message?.type).toBe('error');
		expect(form.message?.text).toContain('cannot be deleted');
	});

	it('rejects a missing code without calling the service', async () => {
		const result = await actions.delete(makeActionEvent({ code: '' }, AUTH_USER));

		expect((result as ActionResult).status).toBe(400);
		expect(deleteCustomCurrency).not.toHaveBeenCalled();
	});
});
