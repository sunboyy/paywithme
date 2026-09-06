import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isRedirect, isHttpError } from '@sveltejs/kit';

// Tests for the `/settings/receiving` server logic (issue #85; PLAN §17.1–§17.2,
// §17.4, §10).
//
// STRATEGY (mirrors the other route specs): the #84 service is mocked, so nothing
// touches a DB and what is asserted is the ROUTE's contract —
//   - the auth guard: every entry point redirects an anonymous caller and never
//     reaches the service;
//   - `load` shows only the CALLER'S OWN profile, and `?edit=` cannot open a row
//     that isn't in it;
//   - every action validates through the service (never against a schema of its
//     own) and answers 404 — never 403 — for another user's id;
//   - REORDER: a move posts the full, swapped id order, and the mismatch error
//     becomes something the page can render;
//   - the form is driven by the REGISTRY: the fields an action reads are the
//     rail's own, so a rail this test invents is submitted correctly and a key no
//     rail declares is dropped.
//
// The rail registry itself is NOT mocked — it is real, shipped data, and the whole
// point of this route is that it renders whatever the registry holds.

const {
	listOwn,
	create,
	update,
	remove,
	reorder,
	InvalidReceivingMethodError,
	ReceivingMethodNotFoundError,
	ReceivingMethodOrderMismatchError
} = vi.hoisted(() => {
	class InvalidReceivingMethodError extends Error {
		readonly code = 'invalid_receiving_method' as const;
		constructor(
			readonly reason: 'unknown_rail' | 'invalid_details',
			readonly error?: unknown
		) {
			super('invalid');
		}
	}
	class ReceivingMethodNotFoundError extends Error {
		readonly code = 'receiving_method_not_found' as const;
	}
	class ReceivingMethodOrderMismatchError extends Error {
		readonly code = 'receiving_method_order_mismatch' as const;
	}
	return {
		listOwn: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		remove: vi.fn(),
		reorder: vi.fn(),
		InvalidReceivingMethodError,
		ReceivingMethodNotFoundError,
		ReceivingMethodOrderMismatchError
	};
});

vi.mock('$lib/server/receiving-methods', () => ({
	listOwn,
	create,
	update,
	remove,
	reorder,
	InvalidReceivingMethodError,
	ReceivingMethodNotFoundError,
	ReceivingMethodOrderMismatchError
}));

import { z } from 'zod';
import { load, actions, type EditorView, type MethodView, type RailView } from './+page.server';
import { thBankAccountDetailsSchema } from '$lib/schemas/receiving-method';

type User = { id: string; name: string };
const AUTH_USER: User = { id: 'u1', name: 'Alice' };

const BANK_DETAILS = {
	bank: 'kbank',
	accountNumber: '1234567890',
	accountHolderName: 'Somchai Jaidee'
};

const PROMPTPAY_DETAILS = {
	proxyType: 'mobile',
	proxyValue: '0812345678',
	accountHolderName: 'Somchai Jaidee'
};

function method(id: string, rail: string, details: unknown, position: number) {
	return { id, userId: 'u1', rail, details, position, createdAt: new Date('2026-01-01') };
}

const BANK = method('rm1', 'th_bank_account', BANK_DETAILS, 0);
const PROMPTPAY = method('rm2', 'th_promptpay', PROMPTPAY_DETAILS, 1);

function makeLoadEvent(user: User | null, search = '') {
	return {
		locals: { user, session: user ? {} : null },
		url: new URL(`http://localhost/settings/receiving${search}`)
	} as unknown as Parameters<typeof load>[0];
}

function makeActionEvent(fields: Record<string, string>, user: User | null) {
	return {
		request: new Request('http://localhost/settings/receiving', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(fields).toString()
		}),
		locals: { user, session: user ? {} : null },
		url: new URL('http://localhost/settings/receiving')
	} as unknown as Parameters<(typeof actions)['add']>[0];
}

/** The `fail(...)` payload an action returns, or its plain success value. */
type Outcome = {
	status?: number;
	data?: Record<string, unknown>;
	intent?: string;
	fieldErrors?: Record<string, string[]>;
	values?: Record<string, string>;
	message?: { type: string; text: string };
};
function outcomeOf(result: unknown): Outcome {
	const r = result as Outcome;
	return (r.data as Outcome) ?? r;
}

/**
 * `load`'s payload. SvelteKit types a `load` as possibly returning `void`, so the
 * spec names the shape it actually returns rather than asserting through `any`.
 */
type LoadResult = { methods: MethodView[]; rails: RailView[]; editing: EditorView | null };
async function loadPage(event: Parameters<typeof load>[0]): Promise<LoadResult> {
	return (await load(event)) as LoadResult;
}

/** Run a handler that is expected to THROW SvelteKit control flow, and return it. */
async function thrownBy(run: () => unknown): Promise<unknown> {
	try {
		await run();
	} catch (e) {
		return e;
	}
	throw new Error('expected the handler to throw');
}

beforeEach(() => {
	listOwn.mockReset();
	create.mockReset();
	update.mockReset();
	remove.mockReset();
	reorder.mockReset();
	listOwn.mockResolvedValue([BANK, PROMPTPAY]);
});

describe('load', () => {
	it('redirects an anonymous visitor to /login and never reads a profile', async () => {
		expect(isRedirect(await thrownBy(() => loadPage(makeLoadEvent(null))))).toBe(true);
		expect(listOwn).not.toHaveBeenCalled();
	});

	it('returns ONLY the caller’s own methods, in position order, formatted by their rail', async () => {
		const result = await loadPage(makeLoadEvent(AUTH_USER));

		// `listOwn` is scoped to the caller's user id — there is no other read here,
		// so no other user's row can reach the page.
		expect(listOwn).toHaveBeenCalledExactlyOnceWith('u1');
		expect(result.methods).toEqual([
			{
				id: 'rm1',
				railLabel: 'Thai bank account',
				summary: 'Kasikornbank (KBank) · 1234567890 · Somchai Jaidee',
				isFirst: true,
				isLast: false
			},
			{
				id: 'rm2',
				railLabel: 'PromptPay',
				summary: 'Mobile number · 0812345678 · Somchai Jaidee',
				isFirst: false,
				isLast: true
			}
		]);
	});

	it('offers every shipped rail with its own fields — the form is registry-driven', async () => {
		const result = await loadPage(makeLoadEvent(AUTH_USER));

		expect(result.rails.map((rail) => rail.id)).toEqual([
			'th_bank_account',
			'th_promptpay',
			'other'
		]);
		for (const rail of result.rails) {
			expect(rail.label.trim(), rail.id).not.toBe('');
			expect(rail.fields.length, rail.id).toBeGreaterThan(0);
		}
	});

	it('opens the add step for `?add=<rail>` with blank values', async () => {
		const result = await loadPage(makeLoadEvent(AUTH_USER, '?add=th_promptpay'));

		expect(result.editing).toEqual({
			methodId: null,
			rail: expect.objectContaining({ id: 'th_promptpay' }),
			values: { proxyType: '', proxyValue: '', accountHolderName: '' }
		});
	});

	it('ignores an unknown rail in `?add=` rather than rendering a form nothing can validate', async () => {
		expect((await loadPage(makeLoadEvent(AUTH_USER, '?add=sepa'))).editing).toBeNull();
	});

	it('opens the edit step for one of the caller’s own methods, prefilled from storage', async () => {
		const result = await loadPage(makeLoadEvent(AUTH_USER, '?edit=rm1'));

		expect(result.editing).toEqual({
			methodId: 'rm1',
			rail: expect.objectContaining({ id: 'th_bank_account' }),
			values: BANK_DETAILS
		});
	});

	it('cannot open another user’s method: it is simply not in the caller’s profile', async () => {
		// `?edit=` is resolved against the caller's OWN list, so a foreign id falls
		// back to the list — and the page says nothing about whether it exists.
		const result = await loadPage(makeLoadEvent(AUTH_USER, '?edit=someone-elses-id'));

		expect(result.editing).toBeNull();
		expect(result.methods).toHaveLength(2);
	});

	it('lists a row whose stored details no longer render, instead of hiding or crashing', async () => {
		// The owner must still be able to delete it — hiding it would leave the row
		// unreachable from the only screen that can remove it.
		listOwn.mockResolvedValueOnce([method('rm3', 'th_bank_account', { bank: 'kbank' }, 0)]);

		const result = await loadPage(makeLoadEvent(AUTH_USER));

		expect(result.methods).toEqual([
			{ id: 'rm3', railLabel: 'Thai bank account', summary: null, isFirst: true, isLast: true }
		]);
	});
});

describe('?/add', () => {
	const VALID = { rail: 'th_bank_account', ...BANK_DETAILS };

	it('redirects an anonymous caller and never reaches the service', async () => {
		expect(isRedirect(await thrownBy(() => actions.add(makeActionEvent(VALID, null))))).toBe(true);
		expect(create).not.toHaveBeenCalled();
	});

	it('hands the rail and exactly its own fields to the service, then redirects', async () => {
		create.mockResolvedValueOnce(BANK);

		const thrown = await thrownBy(() => actions.add(makeActionEvent(VALID, AUTH_USER)));

		expect(create).toHaveBeenCalledExactlyOnceWith('u1', 'th_bank_account', BANK_DETAILS);
		expect(isRedirect(thrown)).toBe(true);
	});

	it('reads only the fields the RAIL declares — a stray key never reaches the service', async () => {
		create.mockResolvedValueOnce(BANK);

		await thrownBy(() =>
			actions.add(makeActionEvent({ ...VALID, position: '99', userId: 'u2' }, AUTH_USER))
		);

		expect(create).toHaveBeenCalledExactlyOnceWith('u1', 'th_bank_account', BANK_DETAILS);
	});

	it('reads a DIFFERENT rail’s fields when that rail is submitted (no per-rail branch)', async () => {
		create.mockResolvedValueOnce(PROMPTPAY);

		await thrownBy(() =>
			actions.add(makeActionEvent({ rail: 'th_promptpay', ...PROMPTPAY_DETAILS }, AUTH_USER))
		);

		expect(create).toHaveBeenCalledExactlyOnceWith('u1', 'th_promptpay', PROMPTPAY_DETAILS);
	});

	it('rejects an unknown rail without calling the service', async () => {
		const result = await actions.add(makeActionEvent({ ...VALID, rail: 'sepa' }, AUTH_USER));

		expect((result as Outcome).status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it('renders the RAIL SCHEMA’S own messages against the right fields, and keeps the input', async () => {
		// The rail's schema is the only validator; the route never restates a rule.
		const invalid = { ...BANK_DETAILS, accountHolderName: '   ' };
		const zodError = thBankAccountDetailsSchema.safeParse(invalid).error!;
		create.mockRejectedValueOnce(new InvalidReceivingMethodError('invalid_details', zodError));

		const result = await actions.add(
			makeActionEvent({ rail: 'th_bank_account', ...invalid }, AUTH_USER)
		);
		const outcome = outcomeOf(result);

		expect((result as Outcome).status).toBe(400);
		expect(outcome.fieldErrors?.accountHolderName).toEqual(
			z.flattenError(zodError).fieldErrors.accountHolderName
		);
		// Re-rendered with what was typed, not blanked.
		expect(outcome.values).toEqual(invalid);
	});

	it('turns an unexpected service failure into a message, never a crash', async () => {
		create.mockRejectedValueOnce(new Error('db down'));

		const result = await actions.add(makeActionEvent(VALID, AUTH_USER));

		expect((result as Outcome).status).toBe(500);
		expect(outcomeOf(result).message?.type).toBe('error');
	});
});

describe('?/edit', () => {
	const VALID = { id: 'rm1', ...BANK_DETAILS, accountHolderName: 'Somchai J' };

	it('redirects an anonymous caller and never reaches the service', async () => {
		expect(isRedirect(await thrownBy(() => actions.edit(makeActionEvent(VALID, null))))).toBe(true);
		expect(update).not.toHaveBeenCalled();
	});

	it('updates through the service using the STORED rail’s fields, then redirects', async () => {
		update.mockResolvedValueOnce(BANK);

		const thrown = await thrownBy(() => actions.edit(makeActionEvent(VALID, AUTH_USER)));

		expect(update).toHaveBeenCalledExactlyOnceWith('u1', 'rm1', {
			...BANK_DETAILS,
			accountHolderName: 'Somchai J'
		});
		expect(isRedirect(thrown)).toBe(true);
	});

	it('ignores a submitted rail: the rail comes from the stored row', async () => {
		// Posting `th_promptpay` at a `th_bank_account` row must not move it onto
		// another rail — the fields read are still the bank rail's.
		update.mockResolvedValueOnce(BANK);

		await thrownBy(() =>
			actions.edit(
				makeActionEvent({ ...VALID, rail: 'th_promptpay', proxyValue: '0812345678' }, AUTH_USER)
			)
		);

		expect(update).toHaveBeenCalledExactlyOnceWith('u1', 'rm1', {
			...BANK_DETAILS,
			accountHolderName: 'Somchai J'
		});
	});

	it('answers 404 — not 403 — for another user’s id, and never calls the service', async () => {
		const thrown = await thrownBy(() =>
			actions.edit(makeActionEvent({ ...VALID, id: 'someone-elses-id' }, AUTH_USER))
		);

		expect(isHttpError(thrown)).toBe(true);
		if (isHttpError(thrown)) expect(thrown.status).toBe(404);
		expect(update).not.toHaveBeenCalled();
	});

	it('answers 404 when the row disappears between the read and the write', async () => {
		update.mockRejectedValueOnce(new ReceivingMethodNotFoundError());

		const thrown = await thrownBy(() => actions.edit(makeActionEvent(VALID, AUTH_USER)));

		expect(isHttpError(thrown)).toBe(true);
		if (isHttpError(thrown)) expect(thrown.status).toBe(404);
	});

	it('renders the rail schema’s field errors on a rejected edit', async () => {
		const invalid = { ...BANK_DETAILS, accountNumber: 'not-digits' };
		const zodError = thBankAccountDetailsSchema.safeParse(invalid).error!;
		update.mockRejectedValueOnce(new InvalidReceivingMethodError('invalid_details', zodError));

		const result = await actions.edit(makeActionEvent({ id: 'rm1', ...invalid }, AUTH_USER));

		expect((result as Outcome).status).toBe(400);
		expect(outcomeOf(result).fieldErrors?.accountNumber?.length).toBeGreaterThan(0);
	});
});

describe('?/delete', () => {
	it('redirects an anonymous caller and never reaches the service', async () => {
		expect(
			isRedirect(await thrownBy(() => actions.delete(makeActionEvent({ id: 'rm1' }, null))))
		).toBe(true);
		expect(remove).not.toHaveBeenCalled();
	});

	it('removes the caller’s own method through the service', async () => {
		remove.mockResolvedValueOnce(BANK);

		const result = await actions.delete(makeActionEvent({ id: 'rm1' }, AUTH_USER));

		expect(remove).toHaveBeenCalledExactlyOnceWith('u1', 'rm1');
		expect(outcomeOf(result).message?.type).toBe('success');
	});

	it('answers 404 for another user’s id (the service conflates it with absent)', async () => {
		remove.mockRejectedValueOnce(new ReceivingMethodNotFoundError());

		const thrown = await thrownBy(() =>
			actions.delete(makeActionEvent({ id: 'someone-elses-id' }, AUTH_USER))
		);

		expect(isHttpError(thrown)).toBe(true);
		if (isHttpError(thrown)) expect(thrown.status).toBe(404);
	});
});

describe('?/move', () => {
	it('redirects an anonymous caller and never reaches the service', async () => {
		const event = makeActionEvent({ id: 'rm1', direction: 'down' }, null);
		expect(isRedirect(await thrownBy(() => actions.move(event)))).toBe(true);
		expect(reorder).not.toHaveBeenCalled();
	});

	it('persists a move down as the FULL swapped order', async () => {
		reorder.mockResolvedValueOnce([PROMPTPAY, BANK]);

		const result = await actions.move(makeActionEvent({ id: 'rm1', direction: 'down' }, AUTH_USER));

		expect(reorder).toHaveBeenCalledExactlyOnceWith('u1', ['rm2', 'rm1']);
		expect(outcomeOf(result).message?.type).toBe('success');
	});

	it('persists a move up as the FULL swapped order', async () => {
		reorder.mockResolvedValueOnce([PROMPTPAY, BANK]);

		await actions.move(makeActionEvent({ id: 'rm2', direction: 'up' }, AUTH_USER));

		expect(reorder).toHaveBeenCalledExactlyOnceWith('u1', ['rm2', 'rm1']);
	});

	it('does nothing at the ends of the list', async () => {
		await actions.move(makeActionEvent({ id: 'rm1', direction: 'up' }, AUTH_USER));
		await actions.move(makeActionEvent({ id: 'rm2', direction: 'down' }, AUTH_USER));

		expect(reorder).not.toHaveBeenCalled();
	});

	it('answers 404 for an id that is not in the caller’s profile', async () => {
		const thrown = await thrownBy(() =>
			actions.move(makeActionEvent({ id: 'someone-elses-id', direction: 'up' }, AUTH_USER))
		);

		expect(isHttpError(thrown)).toBe(true);
		if (isHttpError(thrown)) expect(thrown.status).toBe(404);
		expect(reorder).not.toHaveBeenCalled();
	});

	it('rejects a direction that is neither up nor down', async () => {
		const result = await actions.move(
			makeActionEvent({ id: 'rm1', direction: 'sideways' }, AUTH_USER)
		);

		expect((result as Outcome).status).toBe(400);
		expect(reorder).not.toHaveBeenCalled();
	});

	it('turns a concurrent-change mismatch into a reload-and-retry message, not a 500', async () => {
		reorder.mockRejectedValueOnce(new ReceivingMethodOrderMismatchError());

		const result = await actions.move(makeActionEvent({ id: 'rm1', direction: 'down' }, AUTH_USER));

		expect((result as Outcome).status).toBe(409);
		expect(outcomeOf(result).message?.text).toMatch(/reload/i);
	});
});
