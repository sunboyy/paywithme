import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SEEDED_CURRENCY_DESCRIPTORS } from '$lib/money';

// PREFILL tests for the `new` transaction page `load` — both of them: the §8.4
// settle-via-transfer link (task 5.4) and the §7.7 "Record it" link (issue #51).
// A prefill is a CONVENIENCE built from untrusted URL params, so every case here
// asks the same two questions: does a valid one seed exactly the right fields, and
// does an invalid one fall back to the blank form WITHOUT throwing?
//
// The settle page links here with `?type=transfer&from&to&amount&category`
// to seed a Transfer (payer = debtor, single beneficiary = creditor, amount,
// category = Debt settlement). These tests use the REAL `superValidate` (NOT
// mocked — unlike `page.server.test.ts`) so we assert the ACTUAL seeded `form.data`:
//   - valid params → a transfer seeded with payer=debtor, lone beneficiary=creditor,
//     splitMode=equal, category=transfer-debt-settlement, amountTotal=amount;
//   - invalid params (from not in group, non-numeric amount, etc.) → the blank
//     spending default, WITHOUT throwing (the query string is never trusted).

const { getGroupForUser, listMembers, requireGroupAccess, requireUser } = vi.hoisted(() => ({
	getGroupForUser: vi.fn(),
	listMembers: vi.fn(),
	requireGroupAccess: vi.fn(),
	requireUser: vi.fn()
}));

vi.mock('$lib/server/groups', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/groups')>('$lib/server/groups');
	return { ...actual, getGroupForUser };
});
vi.mock('$lib/server/members', () => ({ listMembers }));

// The Capture service (issue #51): `load` re-reads the note named by `?capture=`
// and seeds the form from THE ROW, never from the URL — the link carries a pointer
// and nothing else.
const { findOpenCapture } = vi.hoisted(() => ({ findOpenCapture: vi.fn() }));
vi.mock('$lib/server/captures', async () => {
	const actual =
		await vi.importActual<typeof import('$lib/server/captures')>('$lib/server/captures');
	return { ...actual, findOpenCapture };
});
vi.mock('$lib/server/access', () => ({ requireGroupAccess, requireUser }));

// The group-scoped ENTRY-CURRENCY set (#63; PLAN §7.5.2). The route reads it for
// the picker AND for the group-scoped entry-currency validator; mocked to the
// seeded 29 so these tests exercise the unchanged seeded-currency behaviour.
const { listCurrenciesForGroup } = vi.hoisted(() => ({ listCurrenciesForGroup: vi.fn() }));
vi.mock('$lib/server/currencies', () => ({ listCurrenciesForGroup }));

import { load } from './+page.server';

const GROUP = { id: 'g1', name: 'Trip', settlementCurrency: 'THB' };
const MEMBERS = [
	{ id: 'm1', displayName: 'Alice', userId: 'u1', deactivatedAt: null, isLinked: true },
	{ id: 'm2', displayName: 'Bob', userId: null, deactivatedAt: null, isLinked: false },
	// A deactivated member — NOT in the active allow-list, so a prefill targeting it
	// must be rejected.
	{
		id: 'm3',
		displayName: 'Carol',
		userId: null,
		deactivatedAt: new Date('2026-01-01'),
		isLinked: false
	}
];

type SeededForm = {
	captureId: string | null;
	form: {
		data: {
			type: string;
			title: string;
			date: string;
			currencyExponent?: number;
			exchangeRate: string;
			categoryId: string;
			amountTotal: number;
			amountTotalSettlement: number;
			splitMode: string;
			currency: string;
			payers: { memberId: string; amountPaid: number }[];
			beneficiaries: { memberId: string }[];
		};
	};
};

/** Build a `load` event whose URL carries the given query string. */
function makeLoadEvent(query = '') {
	return {
		params: { id: 'g1' },
		locals: { user: { id: 'u1', name: 'Alice' }, session: {} },
		url: new URL(`http://localhost/groups/g1/transactions/new${query}`)
	} as unknown as Parameters<typeof load>[0];
}

beforeEach(() => {
	getGroupForUser.mockReset();
	listCurrenciesForGroup.mockReset();
	listCurrenciesForGroup.mockResolvedValue(
		SEEDED_CURRENCY_DESCRIPTORS.map((c) => ({ ...c, name: c.displayCode, isCustom: false }))
	);
	listMembers.mockReset();
	findOpenCapture.mockReset();
	findOpenCapture.mockResolvedValue(null);
	requireGroupAccess.mockReset();
	requireUser.mockReset();

	requireGroupAccess.mockResolvedValue({ user: { id: 'u1', name: 'Alice' }, group: GROUP });
	requireUser.mockReturnValue({ id: 'u1', name: 'Alice' });
	getGroupForUser.mockResolvedValue(GROUP);
	listMembers.mockResolvedValue(MEMBERS);
});

describe('/groups/[id]/transactions/new load — settle prefill (§8.4)', () => {
	it('seeds a Transfer from valid from/to/amount/category params', async () => {
		const result = (await load(
			makeLoadEvent('?type=transfer&from=m2&to=m1&amount=12000&category=transfer-debt-settlement')
		)) as SeededForm;
		const data = result.form.data;

		expect(data.type).toBe('transfer');
		// Settle-up prefill seeds a meaningful default title (still user-editable).
		expect(data.title).toBe('Debt settlement');
		expect(data.categoryId).toBe('transfer-debt-settlement');
		expect(data.splitMode).toBe('equal');
		// payer = debtor pays the whole amount.
		expect(data.payers).toEqual([{ memberId: 'm2', amountPaid: 12000 }]);
		// recipient = creditor is the lone (equal-split) beneficiary.
		expect(data.beneficiaries).toEqual([{ memberId: 'm1' }]);
		expect(data.amountTotal).toBe(12000);
		// Entry currency is the settlement currency → settlement total equals the amount.
		expect(data.amountTotalSettlement).toBe(12000);
		expect(data.currency).toBe('THB');
	});

	it('falls back to the blank spending default when params are absent', async () => {
		const result = (await load(makeLoadEvent())) as SeededForm;
		const data = result.form.data;
		expect(data.type).toBe('spending');
		// Blank default keeps an empty title (the "Debt settlement" seed is prefill-only).
		expect(data.title).toBe('');
		expect(data.amountTotal).toBe(0);
		// Default beneficiaries = all active members (m1, m2); m3 is deactivated.
		expect(data.beneficiaries.map((b) => b.memberId)).toEqual(['m1', 'm2']);
	});

	it.each([
		['from not an active member', '?type=transfer&from=mX&to=m1&amount=100&category=transfer-cash'],
		[
			'to is a deactivated member',
			'?type=transfer&from=m1&to=m3&amount=100&category=transfer-cash'
		],
		[
			'from === to (self transfer)',
			'?type=transfer&from=m1&to=m1&amount=100&category=transfer-cash'
		],
		[
			'non-numeric amount',
			'?type=transfer&from=m2&to=m1&amount=abc&category=transfer-debt-settlement'
		],
		['float amount', '?type=transfer&from=m2&to=m1&amount=12.5&category=transfer-debt-settlement'],
		['zero amount', '?type=transfer&from=m2&to=m1&amount=0&category=transfer-debt-settlement'],
		['negative amount', '?type=transfer&from=m2&to=m1&amount=-5&category=transfer-debt-settlement'],
		[
			'a spending category id',
			'?type=transfer&from=m2&to=m1&amount=100&category=spending-food-drink'
		],
		['an unknown category id', '?type=transfer&from=m2&to=m1&amount=100&category=nope'],
		['type is not transfer', '?type=spending&from=m2&to=m1&amount=100&category=transfer-cash'],
		['missing to', '?type=transfer&from=m2&amount=100&category=transfer-cash']
	])('falls back to the blank default without throwing: %s', async (_label, query) => {
		const result = (await load(makeLoadEvent(query))) as SeededForm;
		const data = result.form.data;
		// Untrusted/invalid params must NEVER seed a transfer — blank spending default.
		expect(data.type).toBe('spending');
		expect(data.amountTotal).toBe(0);
		expect(data.beneficiaries.map((b) => b.memberId)).toEqual(['m1', 'm2']);
	});
});

// ── The "Record it" prefill (issue #51; PLAN §7.7 "Resolving") ────────────────
// `?capture=<id>` seeds the form from the note: `note` → title, `amount_minor` +
// `currency` → the amount, `captured_for` → the editable real-world `created_at`
// day (§7.1 — the reversal that makes `created_at` the date and `occurred_at` the
// insert time). Nothing else: a note carries no payers, beneficiaries, split mode
// or rate (ADR-0012), so the rest is entered normally.

/** One open note, as the service returns it. */
function openNote(overrides: Record<string, unknown> = {}) {
	return {
		id: 'cap-1',
		groupId: 'g1',
		createdBy: 'u1',
		note: 'dinner at the night market',
		amountMinor: 120000,
		currency: 'THB',
		capturedFor: '2026-08-01',
		resolvedTransactionId: null,
		resolvedAt: null,
		discardedAt: null,
		createdAt: new Date('2026-08-01T12:00:00Z'),
		...overrides
	};
}

describe('/groups/[id]/transactions/new load — the "Record it" prefill (§7.7)', () => {
	it("seeds the note, the amount and the note's own day", async () => {
		findOpenCapture.mockResolvedValue(openNote());

		const result = (await load(makeLoadEvent('?capture=cap-1'))) as SeededForm;
		const data = result.form.data;

		expect(findOpenCapture).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			captureId: 'cap-1'
		});
		expect(data.title).toBe('dinner at the night market');
		expect(data.amountTotal).toBe(120000);
		expect(data.currency).toBe('THB');
		// `captured_for` → the transaction's EDITABLE real-world date (§7.1).
		expect(data.date).toBe('2026-08-01');
		// Same currency as the group settles in → the rate seam stays a no-op.
		expect(data.exchangeRate).toBe('1');
		expect(data.amountTotalSettlement).toBe(120000);
		// The single default payer mirrors the total, so the form is savable as seeded
		// (this is what the no-JS POST submits).
		expect(data.payers).toEqual([{ memberId: 'm1', amountPaid: 120000 }]);
		// A note carries NO split information — the ordinary equal-split default stands.
		expect(data.splitMode).toBe('equal');
		expect(data.beneficiaries.map((b) => b.memberId)).toEqual(['m1', 'm2']);
		expect(data.type).toBe('spending');
		// The id travels to the page so the save can stamp the note (§12.1).
		expect(result.captureId).toBe('cap-1');
	});

	it('seeds a note-only reminder with the title and date, and no amount', async () => {
		findOpenCapture.mockResolvedValue(openNote({ amountMinor: null, currency: null }));

		const result = (await load(makeLoadEvent('?capture=cap-1'))) as SeededForm;
		const data = result.form.data;

		expect(data.title).toBe('dinner at the night market');
		expect(data.date).toBe('2026-08-01');
		expect(data.amountTotal).toBe(0);
		expect(data.currency).toBe('THB');
		expect(data.exchangeRate).toBe('1');
	});

	it('seeds a FOREIGN amount with an empty rate for the user to enter (§7.6)', async () => {
		findOpenCapture.mockResolvedValue(openNote({ amountMinor: 9000, currency: 'JPY' }));

		const result = (await load(makeLoadEvent('?capture=cap-1'))) as SeededForm;
		const data = result.form.data;

		expect(data.currency).toBe('JPY');
		// The scale the seeded minor units mean (§7.5.2) — JPY has no minor unit.
		expect(data.currencyExponent).toBe(0);
		expect(data.amountTotal).toBe(9000);
		// A note stores no rate and no conversion (§7.7), so none is invented: a
		// plausible "1" would quietly record a wrong ledger figure.
		expect(data.exchangeRate).toBe('');
		expect(data.amountTotalSettlement).toBe(0);
	});

	it('drops an amount whose currency the group no longer has', async () => {
		// `captures.currency` is deliberately not a foreign key, so a custom currency
		// deleted since leaves the code dangling — and then the amount has no scale to
		// be read at. Re-entered by the user rather than guessed.
		findOpenCapture.mockResolvedValue(openNote({ amountMinor: 4, currency: 'cur_gone' }));

		const result = (await load(makeLoadEvent('?capture=cap-1'))) as SeededForm;
		const data = result.form.data;

		expect(data.title).toBe('dinner at the night market');
		expect(data.amountTotal).toBe(0);
		expect(data.currency).toBe('THB');
		expect(data.exchangeRate).toBe('1');
	});

	it.each([
		['a stale or already-closed note', null],
		['a note this group cannot see', null]
	])('falls back to the blank form for %s', async (_label, row) => {
		findOpenCapture.mockResolvedValue(row);

		const result = (await load(makeLoadEvent('?capture=whatever'))) as SeededForm;

		expect(result.form.data.title).toBe('');
		expect(result.form.data.amountTotal).toBe(0);
		// Nothing to stamp → the save records an ordinary transaction.
		expect(result.captureId).toBeNull();
	});

	it('falls back to the blank form (no error page) when the read fails', async () => {
		findOpenCapture.mockRejectedValue(new Error('db down'));

		const result = (await load(makeLoadEvent('?capture=cap-1'))) as SeededForm;

		expect(result.form.data.title).toBe('');
		expect(result.captureId).toBeNull();
	});

	it('reads no note at all on a plain visit', async () => {
		const result = (await load(makeLoadEvent())) as SeededForm;

		expect(findOpenCapture).not.toHaveBeenCalled();
		expect(result.captureId).toBeNull();
	});

	it('leaves a settle-up prefill alone (one seeded form, one source)', async () => {
		findOpenCapture.mockResolvedValue(openNote());

		const result = (await load(
			makeLoadEvent(
				'?type=transfer&from=m2&to=m1&amount=12000&category=transfer-debt-settlement&capture=cap-1'
			)
		)) as SeededForm;

		expect(result.form.data.type).toBe('transfer');
		expect(result.form.data.title).toBe('Debt settlement');
		expect(findOpenCapture).not.toHaveBeenCalled();
		expect(result.captureId).toBeNull();
	});
});
