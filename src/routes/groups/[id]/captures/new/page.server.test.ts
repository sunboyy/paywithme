import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { SEEDED_CURRENCY_DESCRIPTORS } from '$lib/money';

// Route tests for the quick-capture screen (issue #50; PLAN §7.7, §10).
//
// The service is mocked (no DB): what belongs to THIS layer, and is tested here, is
// everything between the submitted form and the service call —
//
//   - the note is the ONE required field, and everything else has a default;
//   - the typed MAJOR-unit amount becomes integer MINOR units at the CHOSEN
//     currency's exponent (the conversion the client does on the transaction form
//     happens here instead, so it survives with JS off);
//   - amount and currency travel as ONE fact: a blank amount posts NEITHER, which
//     is what keeps a note-only Capture from tripping the schema's pairing rule;
//   - a rejected submit comes back as FIELD errors on the form's own field names
//     (`amountMinor` → `amount`), never as a 500;
//   - success REDIRECTS, so a reload cannot re-post it.

const { createCapture, requireGroupAccess, requireUser, listCurrenciesForGroup } = vi.hoisted(
	() => ({
		createCapture: vi.fn(),
		requireGroupAccess: vi.fn(),
		requireUser: vi.fn(),
		listCurrenciesForGroup: vi.fn()
	})
);

vi.mock('$lib/server/captures', async () => {
	const actual =
		await vi.importActual<typeof import('$lib/server/captures')>('$lib/server/captures');
	return { ...actual, createCapture };
});
vi.mock('$lib/server/access', () => ({ requireGroupAccess, requireUser }));
vi.mock('$lib/server/currencies', () => ({ listCurrenciesForGroup }));

import { load, actions } from './+page.server';
import { CaptureValidationError } from '$lib/server/captures';
import { GroupAccessError } from '$lib/server/groups';

const USER = { id: 'u1', name: 'Alice' };
const GROUP = { id: 'g1', name: 'Trip', settlementCurrency: 'THB' };

/** This group's own custom currency: opaque PK, member-typed display code, 0-dp. */
const BEER = {
	code: 'cur_beer',
	displayCode: 'BEER',
	name: 'Bottle of beer',
	symbol: '🍺',
	exponent: 0,
	isCustom: true
};

/** What `listCurrenciesForGroup` returns: the seeded 29 first, then the group's own. */
function groupCurrencies(custom: (typeof BEER)[] = []) {
	return [
		...SEEDED_CURRENCY_DESCRIPTORS.map((c) => ({ ...c, name: c.displayCode, isCustom: false })),
		...custom
	];
}

function makeLoadEvent() {
	return {
		params: { id: 'g1' },
		locals: { user: USER, session: {} },
		url: new URL('http://localhost/groups/g1/captures/new')
	} as unknown as Parameters<typeof load>[0];
}

function makeActionEvent(fields: Record<string, string>) {
	const data = new FormData();
	for (const [k, v] of Object.entries(fields)) data.set(k, v);
	return {
		params: { id: 'g1' },
		locals: { user: USER, session: {} },
		url: new URL('http://localhost/groups/g1/captures/new'),
		request: { formData: async () => data }
	} as unknown as Parameters<NonNullable<typeof actions.default>>[0];
}

/**
 * Run the default action and RETURN whatever it produced — its `fail()` payload, or
 * the `redirect()` / `error()` it threw. SvelteKit signals both of those by
 * throwing, so returning them keeps every assertion in one shape.
 */
async function submit(fields: Record<string, string>) {
	try {
		return await actions.default!(makeActionEvent(fields));
	} catch (e) {
		return e;
	}
}

/** The input object handed to `createCapture`. */
function capturedInput(): Record<string, unknown> {
	return createCapture.mock.calls[0][0].input;
}

beforeEach(() => {
	createCapture.mockReset();
	createCapture.mockResolvedValue({ id: 'cap-1' });
	requireGroupAccess.mockReset();
	requireGroupAccess.mockResolvedValue({ user: USER, group: GROUP });
	requireUser.mockReset();
	requireUser.mockReturnValue(USER);
	listCurrenciesForGroup.mockReset();
	listCurrenciesForGroup.mockResolvedValue(groupCurrencies());
});

describe('/groups/[id]/captures/new load', () => {
	it('seeds the screen with the group currency and today, and a blank note', async () => {
		const result = (await load(makeLoadEvent())) as {
			group: { id: string; name: string; settlementCurrency: string };
			values: { note: string; amount: string; currency: string; capturedFor: string };
		};

		expect(result.group).toEqual({ id: 'g1', name: 'Trip', settlementCurrency: 'THB' });
		expect(result.values.note).toBe('');
		expect(result.values.amount).toBe('');
		// The currency defaults to the GROUP's (PLAN §7.7).
		expect(result.values.currency).toBe('THB');
		// The date defaults to today, so the field never has to be touched.
		expect(result.values.capturedFor).toBe(new Date().toISOString().slice(0, 10));
	});

	it('offers the group-scoped currency set, showing display codes only', async () => {
		listCurrenciesForGroup.mockResolvedValueOnce(groupCurrencies([BEER]));

		const result = (await load(makeLoadEvent())) as {
			currencies: { code: string; displayCode: string }[];
		};

		const beer = result.currencies.find((c) => c.code === 'cur_beer');
		expect(beer?.displayCode).toBe('BEER');
		expect(result.currencies.some((c) => c.code === 'THB')).toBe(true);
	});
});

describe('/groups/[id]/captures/new default action', () => {
	it('records a note-only Capture and redirects to the tray', async () => {
		const outcome = await submit({ note: '  dinner at the night market  ' });

		expect(createCapture).toHaveBeenCalledTimes(1);
		expect(createCapture.mock.calls[0][0]).toMatchObject({ userId: 'u1', groupId: 'g1' });
		expect(capturedInput().note).toBe('  dinner at the night market  ');
		// A blank amount posts NEITHER half of the money pair — that is what "I don't
		// know yet" means, and it is what keeps the schema's pairing rule quiet.
		expect(capturedInput()).not.toHaveProperty('amountMinor');
		expect(capturedInput()).not.toHaveProperty('currency');

		expect(isRedirect(outcome)).toBe(true);
		expect((outcome as unknown as { location: string }).location).toBe('/groups/g1/transactions');
	});

	it('converts the typed MAJOR-unit amount to minor units at the currency exponent', async () => {
		await submit({ note: 'dinner', amount: '1,200.50', currency: 'THB' });

		expect(capturedInput().amountMinor).toBe(120_050);
		expect(capturedInput().currency).toBe('THB');
	});

	it('uses the CUSTOM currency own exponent, and stores its opaque code', async () => {
		listCurrenciesForGroup.mockResolvedValue(groupCurrencies([BEER]));

		await submit({ note: 'a round', amount: '3', currency: 'cur_beer' });

		// 0-dp: three beers are 3 minor units, not 300.
		expect(capturedInput().amountMinor).toBe(3);
		expect(capturedInput().currency).toBe('cur_beer');
	});

	it('rejects an amount the currency cannot express, as a FIELD error not a 500', async () => {
		// THB is 2-dp: a third decimal place is refused rather than rounded away.
		const outcome = (await submit({ note: 'dinner', amount: '12.345', currency: 'THB' })) as {
			status: number;
			data: { fieldErrors?: Record<string, string[]>; values: { amount: string } };
		};

		expect(outcome.status).toBe(400);
		expect(outcome.data.fieldErrors?.amount).toBeDefined();
		expect(createCapture).not.toHaveBeenCalled();
		// What was typed comes back, so the form re-renders filled in.
		expect(outcome.data.values.amount).toBe('12.345');
	});

	it('rejects a currency outside the group set with the shared, non-leaking message', async () => {
		const outcome = (await submit({
			note: 'dinner',
			amount: '10',
			currency: 'cur_another_group'
		})) as { status: number; data: { fieldErrors?: Record<string, string[]> } };

		expect(outcome.status).toBe(400);
		expect(outcome.data.fieldErrors?.currency).toEqual(['Select a supported currency']);
		expect(createCapture).not.toHaveBeenCalled();
	});

	it('omits a blank date so the schema default (today) applies, not a second one', async () => {
		await submit({ note: 'dinner', capturedFor: '' });
		expect(capturedInput().capturedFor).toBeUndefined();
	});

	it('passes a chosen backdate straight through (§7.7 real-world date)', async () => {
		await submit({ note: 'dinner', capturedFor: '2026-08-29' });
		expect(capturedInput().capturedFor).toBe('2026-08-29');
	});

	it("surfaces the shared schema's issues on the FORM's field names", async () => {
		createCapture.mockRejectedValueOnce(
			new CaptureValidationError([
				{ code: 'custom', path: ['note'], message: 'A note is required' },
				{ code: 'custom', path: ['amountMinor'], message: 'Amount must be more than zero' }
			] as never)
		);

		const outcome = (await submit({ note: ' ' })) as {
			status: number;
			data: { fieldErrors?: Record<string, string[]> };
		};

		expect(outcome.status).toBe(400);
		expect(outcome.data.fieldErrors?.note).toEqual(['A note is required']);
		// `amountMinor` is the SCHEMA's field; `amount` is the one on screen.
		expect(outcome.data.fieldErrors?.amount).toEqual(['Amount must be more than zero']);
		expect(outcome.data.fieldErrors?.amountMinor).toBeUndefined();
	});

	it('answers a lost group with 404, never leaking that it exists (§12)', async () => {
		createCapture.mockRejectedValueOnce(new GroupAccessError());

		const thrown = await submit({ note: 'dinner' });
		expect(isHttpError(thrown)).toBe(true);
		expect((thrown as { status: number }).status).toBe(404);
	});

	it('degrades an unexpected service failure to a form message, never the cause', async () => {
		createCapture.mockRejectedValueOnce(new Error('connection terminated: secret-host:5432'));

		const outcome = (await submit({ note: 'dinner' })) as {
			status: number;
			data: { message?: { text: string } };
		};

		expect(outcome.status).toBe(500);
		expect(outcome.data.message?.text).toBe('Could not save that. Please try again.');
		expect(JSON.stringify(outcome.data)).not.toContain('secret-host');
	});

	it('derives the author from the SESSION, never from the submission', async () => {
		await submit({ note: 'dinner', createdBy: 'someone-else', groupId: 'other-group' });

		expect(createCapture.mock.calls[0][0].userId).toBe('u1');
		expect(createCapture.mock.calls[0][0].groupId).toBe('g1');
		// The shallowness is the spec: nothing else rides along into the service.
		expect(Object.keys(capturedInput()).sort()).toEqual(['capturedFor', 'note']);
	});
});
