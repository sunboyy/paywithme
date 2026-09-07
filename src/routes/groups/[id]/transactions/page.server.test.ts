import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { SEEDED_CURRENCY_DESCRIPTORS } from '$lib/money';

// Route test for the transaction list `load` (task 4.7): the filter state is
// parsed from `url.searchParams` and passed to `listTransactions`; the shaped
// rows + filter state come back. Services are mocked (no real DB).
//
// The GROUP-SCOPED currency set (#63; PLAN §7.5.2) is mocked here too. It is not
// optional scaffolding: `load` reads it for every row's ENTRY-currency descriptor
// (§7.6 Display), so leaving it unmocked would have the real service hit a DB that
// isn't there.

const {
	listTransactions,
	requireGroupAccess,
	requireUser,
	listMembers,
	listCurrenciesForGroup,
	listOpenCaptures,
	discardCapture
} = vi.hoisted(() => ({
	listTransactions: vi.fn(),
	requireGroupAccess: vi.fn(),
	requireUser: vi.fn(),
	listMembers: vi.fn(),
	listCurrenciesForGroup: vi.fn(),
	listOpenCaptures: vi.fn(),
	discardCapture: vi.fn()
}));

vi.mock('$lib/server/transactions', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/transactions')>(
		'$lib/server/transactions'
	);
	return { ...actual, listTransactions };
});
vi.mock('$lib/server/access', () => ({ requireGroupAccess, requireUser }));
vi.mock('$lib/server/captures', async () => {
	const actual =
		await vi.importActual<typeof import('$lib/server/captures')>('$lib/server/captures');
	return { ...actual, listOpenCaptures, discardCapture };
});
vi.mock('$lib/server/members', () => ({ listMembers }));
vi.mock('$lib/server/currencies', () => ({ listCurrenciesForGroup }));

import { load, actions } from './+page.server';
import { GroupAccessError } from '$lib/server/groups';
import { CaptureNotFoundError, CaptureNotOpenError } from '$lib/server/captures';

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
		...SEEDED_CURRENCY_DESCRIPTORS.map((c) => ({
			...c,
			name: c.displayCode,
			isCustom: false
		})),
		...custom
	];
}

function makeLoadEvent(search: string) {
	return {
		params: { id: 'g1' },
		locals: { user: { id: 'u1', name: 'Alice' }, session: {} },
		url: new URL(`http://localhost/groups/g1/transactions${search}`)
	} as unknown as Parameters<typeof load>[0];
}

beforeEach(() => {
	listTransactions.mockReset();
	requireGroupAccess.mockReset();
	requireGroupAccess.mockResolvedValue({ user: { id: 'u1', name: 'Alice' }, group: GROUP });
	listTransactions.mockResolvedValue([]);
	listCurrenciesForGroup.mockReset();
	listCurrenciesForGroup.mockResolvedValue(groupCurrencies());
	requireUser.mockReset();
	requireUser.mockReturnValue({ id: 'u1', name: 'Alice' });
	listOpenCaptures.mockReset();
	listOpenCaptures.mockResolvedValue([]);
	discardCapture.mockReset();
	discardCapture.mockResolvedValue({ id: 'cap-1' });
	listMembers.mockReset();
	// Two members: the viewer (linked to u1) and one other participant slot.
	listMembers.mockResolvedValue([
		{ id: 'm1', displayName: 'Alice', userId: 'u1', deactivatedAt: null, isLinked: true },
		{ id: 'm2', displayName: 'Bob', userId: null, deactivatedAt: null, isLinked: false }
	]);
});

describe('/groups/[id]/transactions load', () => {
	it('parses no filters when the query string is empty', async () => {
		const result = (await load(makeLoadEvent(''))) as {
			filters: { type: string | null; category: string | null };
			transactions: unknown[];
			currency: { code: string };
		};
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: { type: undefined, categoryId: undefined }
		});
		// Exhaustive on purpose: `filters` is the page's whole filter state, and the
		// §10 member filter added `member`/`role` to it (both null when unset).
		expect(result.filters).toEqual({ type: null, category: null, member: null, role: null });
		expect(result.currency.code).toBe('THB');
	});

	it('parses the type + category filters from the URL', async () => {
		const result = (await load(makeLoadEvent('?type=transfer&category=transfer-cash'))) as {
			filters: { type: string | null; category: string | null };
		};

		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: { type: 'transfer', categoryId: 'transfer-cash' }
		});
		expect(result.filters).toEqual({
			type: 'transfer',
			category: 'transfer-cash',
			member: null,
			role: null
		});
	});

	it('ignores an unrecognized type value (no filter)', async () => {
		await load(makeLoadEvent('?type=bogus'));
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: { type: undefined, categoryId: undefined }
		});
	});

	it('returns the shaped transactions from the service', async () => {
		listTransactions.mockResolvedValueOnce([
			{
				id: 't1',
				type: 'spending',
				title: 'Dinner',
				categoryId: 'spending-food-drink',
				categoryName: 'Food & Drink',
				categoryIcon: 'utensils',
				amountTotalSettlement: 9000,
				settlementCurrency: 'THB',
				createdAt: '2026-03-01T00:00:00.000Z'
			}
		]);
		const result = (await load(makeLoadEvent(''))) as { transactions: { id: string }[] };
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].id).toBe('t1');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The §10 MEMBER filter — "show only what relates to me (or another person)".
// ─────────────────────────────────────────────────────────────────────────────

describe('/groups/[id]/transactions load — member filter (PLAN §10)', () => {
	type MemberResult = {
		filters: { member: string | null; role: string | null };
		members: { id: string; isSelf: boolean; isInactive: boolean }[];
	};

	it('passes the member filter through and echoes it back', async () => {
		const result = (await load(makeLoadEvent('?member=m1'))) as MemberResult;
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: { type: undefined, categoryId: undefined, memberId: 'm1', memberRole: undefined }
		});
		expect(result.filters.member).toBe('m1');
		expect(result.filters.role).toBeNull();
	});

	it.each(['paid', 'owes'] as const)(
		'passes role=%s through alongside the member',
		async (role) => {
			const result = (await load(makeLoadEvent(`?member=m1&role=${role}`))) as MemberResult;
			expect(listTransactions).toHaveBeenCalledWith({
				userId: 'u1',
				groupId: 'g1',
				filters: { type: undefined, categoryId: undefined, memberId: 'm1', memberRole: role }
			});
			expect(result.filters.role).toBe(role);
		}
	);

	it('ignores an unrecognized role value (falls back to EITHER side)', async () => {
		const result = (await load(makeLoadEvent('?member=m1&role=bogus'))) as MemberResult;
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: { type: undefined, categoryId: undefined, memberId: 'm1', memberRole: undefined }
		});
		expect(result.filters.role).toBeNull();
	});

	it('DROPS a role given without a member — it never reaches the service', async () => {
		const result = (await load(makeLoadEvent('?role=paid'))) as MemberResult;
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: {
				type: undefined,
				categoryId: undefined,
				memberId: undefined,
				memberRole: undefined
			}
		});
		expect(result.filters.role).toBeNull();
	});

	it('treats an empty member param as no filter', async () => {
		const result = (await load(makeLoadEvent('?member='))) as MemberResult;
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: {
				type: undefined,
				categoryId: undefined,
				memberId: undefined,
				memberRole: undefined
			}
		});
		expect(result.filters.member).toBeNull();
	});

	it('composes with the type + category filters', async () => {
		await load(makeLoadEvent('?type=spending&category=spending-food-drink&member=m2&role=owes'));
		expect(listTransactions).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			filters: {
				type: 'spending',
				categoryId: 'spending-food-drink',
				memberId: 'm2',
				memberRole: 'owes'
			}
		});
	});

	it('returns the group members, marking the viewer as self', async () => {
		const result = (await load(makeLoadEvent(''))) as MemberResult;
		expect(listMembers).toHaveBeenCalledWith({ userId: 'u1', groupId: 'g1' });
		expect(result.members).toEqual([
			{ id: 'm1', displayName: 'Alice', isSelf: true, isInactive: false },
			{ id: 'm2', displayName: 'Bob', isSelf: false, isInactive: false }
		]);
	});

	it('keeps DEACTIVATED members selectable, marked inactive (§6.3 — they keep their history)', async () => {
		listMembers.mockResolvedValueOnce([
			{
				id: 'm3',
				displayName: 'Carol',
				userId: null,
				deactivatedAt: '2026-02-01T00:00:00.000Z',
				isLinked: false
			}
		]);
		const result = (await load(makeLoadEvent(''))) as MemberResult;
		expect(result.members).toEqual([
			{ id: 'm3', displayName: 'Carol', isSelf: false, isInactive: true }
		]);
	});

	it('degrades to no member filter (rather than 500) when the member read fails', async () => {
		listMembers.mockRejectedValueOnce(new Error('db down'));
		const result = (await load(makeLoadEvent(''))) as MemberResult;
		expect(result.members).toEqual([]);
	});
});

// ── The group-scoped ENTRY-currency set reaching the page (#63; PLAN §7.5.2) ──
//
// The list renders each row's ORIGINAL amount in the currency it was RECORDED in
// (§7.6 Display). A group-defined currency exists only as a `currencies` row, so
// the page cannot format one from its code alone — the resolved descriptor has to
// travel in `data.currencies`. These assert that wiring at load level; the
// rendering itself is covered by `mount.svelte.test.ts`.
describe('/groups/[id]/transactions load — entry-currency descriptors (§7.5.2)', () => {
	it("passes the group's own custom row through to `currencies`", async () => {
		listCurrenciesForGroup.mockResolvedValue(groupCurrencies([BEER]));

		const result = (await load(makeLoadEvent(''))) as {
			currencies: { code: string; displayCode: string; symbol: string; exponent: number }[];
		};

		expect(listCurrenciesForGroup).toHaveBeenCalledWith({ userId: 'u1', groupId: 'g1' });
		expect(result.currencies).toContainEqual({
			code: 'cur_beer',
			displayCode: 'BEER',
			symbol: '🍺',
			exponent: 0
		});
	});

	it('carries every seeded currency with `displayCode === code`', async () => {
		const result = (await load(makeLoadEvent(''))) as {
			currencies: { code: string; displayCode: string }[];
		};
		// The seeded invariant (PLAN §7.5.2) — a seeded row's display code IS its code,
		// so a same-currency row keeps formatting exactly as it did before #63.
		expect(result.currencies).toHaveLength(SEEDED_CURRENCY_DESCRIPTORS.length);
		expect(result.currencies.every((c) => c.code === c.displayCode)).toBe(true);
		expect(result.currencies.find((c) => c.code === 'THB')?.displayCode).toBe('THB');
	});

	it('the settlement currency travels with a displayCode too', async () => {
		const result = (await load(makeLoadEvent(''))) as {
			currency: { code: string; displayCode: string };
		};
		expect(result.currency).toEqual(expect.objectContaining({ code: 'THB', displayCode: 'THB' }));
	});

	it('404s (never 500s) when the currency read loses the access race', async () => {
		// Access was established moments earlier, so this can only be the group
		// vanishing mid-request — the same answer the transaction read gives.
		listCurrenciesForGroup.mockRejectedValue(new GroupAccessError());
		try {
			await load(makeLoadEvent(''));
			expect.unreachable('load should have thrown');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			expect((e as { status: number }).status).toBe(404);
		}
	});

	it('PROPAGATES a real currency-read failure instead of degrading to an empty set', async () => {
		// An empty currency set is not a coherent page: a row recorded in a custom
		// currency would then have no descriptor to format with and the component would
		// throw anyway. Swallowing this is also what previously hid the fact that these
		// tests never mocked the service at all.
		listCurrenciesForGroup.mockRejectedValue(new Error('connection refused'));
		await expect(load(makeLoadEvent(''))).rejects.toThrow('connection refused');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The "Not recorded yet" tray + its discard action (issue #50; PLAN §7.7, §10).
// ─────────────────────────────────────────────────────────────────────────────

/** A stored Capture row, as `listOpenCaptures` returns it. */
function captureRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'cap-1',
		groupId: 'g1',
		createdBy: 'u1',
		note: 'dinner at the night market',
		amountMinor: null,
		currency: null,
		capturedFor: '2026-08-01',
		resolvedTransactionId: null,
		resolvedAt: null,
		discardedAt: null,
		createdAt: new Date('2026-08-01T12:00:00Z'),
		...overrides
	};
}

type TrayResult = {
	captures: {
		id: string;
		note: string;
		authorName: string;
		amountFormatted: string | null;
		capturedFor: string;
	}[];
};

describe('/groups/[id]/transactions load — the "Not recorded yet" tray (§7.7)', () => {
	it('reads the group tray and attributes each note to its AUTHOR', async () => {
		// Two members' notes, in the order the service returned them.
		listOpenCaptures.mockResolvedValueOnce([
			captureRow(),
			captureRow({ id: 'cap-2', createdBy: 'u2', note: 'that taxi' })
		]);
		listMembers.mockResolvedValueOnce([
			{ id: 'm1', displayName: 'Alice', userId: 'u1', deactivatedAt: null, isLinked: true },
			{ id: 'm2', displayName: 'Bob', userId: 'u2', deactivatedAt: null, isLinked: true }
		]);

		const result = (await load(makeLoadEvent(''))) as TrayResult;

		expect(listOpenCaptures).toHaveBeenCalledWith('u1', 'g1');
		// Group-visible: EVERY member's open notes, not just the viewer's — that is
		// what makes the tray deduplicate (§7.7).
		expect(result.captures.map((c) => [c.id, c.authorName])).toEqual([
			['cap-1', 'Alice'],
			['cap-2', 'Bob']
		]);
		// Service order is preserved (newest real-world day first).
		expect(result.captures[0].note).toBe('dinner at the night market');
	});

	it('still names a DEACTIVATED author (they keep their history, §6.3)', async () => {
		listOpenCaptures.mockResolvedValueOnce([captureRow({ createdBy: 'u3' })]);
		listMembers.mockResolvedValueOnce([
			{
				id: 'm3',
				displayName: 'Carol',
				userId: 'u3',
				deactivatedAt: '2026-02-01T00:00:00.000Z',
				isLinked: true
			}
		]);

		const result = (await load(makeLoadEvent(''))) as TrayResult;
		expect(result.captures[0].authorName).toBe('Carol');
	});

	it('falls back to a generic label rather than printing a raw user id', async () => {
		listOpenCaptures.mockResolvedValueOnce([captureRow({ createdBy: 'u-ghost' })]);

		const result = (await load(makeLoadEvent(''))) as TrayResult;
		expect(result.captures[0].authorName).toBe('Someone');
		expect(result.captures[0].authorName).not.toContain('u-ghost');
	});

	it('formats the amount at its own currency exponent — and converts NOTHING', async () => {
		listCurrenciesForGroup.mockResolvedValue(groupCurrencies([BEER]));
		listOpenCaptures.mockResolvedValueOnce([
			captureRow({ amountMinor: 120_000, currency: 'THB' }),
			// A 0-dp custom currency: three beers, not "3.00", and no settlement
			// equivalent anywhere — nothing that computes a balance may see a Capture.
			captureRow({ id: 'cap-2', amountMinor: 3, currency: 'cur_beer' })
		]);

		const result = (await load(makeLoadEvent(''))) as TrayResult;

		// Settlement currency: bare symbol (the group states its currency once).
		expect(result.captures[0].amountFormatted).toBe('฿1,200.00');
		// Foreign: the DISPLAY code rides along, never the opaque key.
		expect(result.captures[1].amountFormatted).toContain('BEER');
		expect(result.captures[1].amountFormatted).not.toContain('cur_beer');
		expect(result.captures[1].amountFormatted).not.toContain('3.00');
	});

	it('shows no amount for a note-only Capture', async () => {
		listOpenCaptures.mockResolvedValueOnce([captureRow()]);
		const result = (await load(makeLoadEvent(''))) as TrayResult;
		expect(result.captures[0].amountFormatted).toBeNull();
	});

	it('shows no amount when the currency no longer resolves, rather than guessing a scale', async () => {
		// `captures.currency` is deliberately NOT a foreign key (a group may delete a
		// custom currency the ledger never referenced), so a code CAN dangle.
		listOpenCaptures.mockResolvedValueOnce([
			captureRow({ amountMinor: 1234, currency: 'cur_deleted' })
		]);
		const result = (await load(makeLoadEvent(''))) as TrayResult;
		expect(result.captures[0].amountFormatted).toBeNull();
	});

	it('degrades to an empty tray (not a 500) when the read fails', async () => {
		listOpenCaptures.mockRejectedValueOnce(new Error('db down'));
		const result = (await load(makeLoadEvent(''))) as TrayResult;
		expect(result.captures).toEqual([]);
	});

	it('404s when the tray read loses the access race', async () => {
		listOpenCaptures.mockRejectedValueOnce(new GroupAccessError());
		try {
			await load(makeLoadEvent(''));
			expect.unreachable('load should have thrown');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			expect((e as { status: number }).status).toBe(404);
		}
	});
});

/** Post the discard action with the given form fields; returns its result or throw. */
async function discard(fields: Record<string, string>) {
	const data = new FormData();
	for (const [k, v] of Object.entries(fields)) data.set(k, v);
	const event = {
		params: { id: 'g1' },
		locals: { user: { id: 'u1', name: 'Alice' }, session: {} },
		url: new URL('http://localhost/groups/g1/transactions'),
		request: { formData: async () => data }
	} as unknown as Parameters<NonNullable<typeof actions.discard>>[0];
	try {
		return await actions.discard!(event);
	} catch (e) {
		return e;
	}
}

describe('/groups/[id]/transactions discard action (§7.7 "Edge cases", §10)', () => {
	it('soft-discards through the service — the REAL action behind the dialog', async () => {
		const outcome = (await discard({ captureId: 'cap-1' })) as { message: { type: string } };

		// The dialog is a UX guard; this is the mechanism, and it needs nothing from
		// the client but the id — so it works with JavaScript off.
		expect(discardCapture).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			captureId: 'cap-1'
		});
		expect(outcome.message.type).toBe('success');
	});

	it('rejects a submission with no id without touching the service', async () => {
		const outcome = (await discard({})) as { status: number };
		expect(outcome.status).toBe(400);
		expect(discardCapture).not.toHaveBeenCalled();
	});

	it('says which ending won the race when someone else already closed it', async () => {
		discardCapture.mockRejectedValueOnce(new CaptureNotOpenError('resolved'));

		const outcome = (await discard({ captureId: 'cap-1' })) as {
			status: number;
			data: { message: { text: string } };
		};

		// The tray is group-visible, so two people CAN act on one row. Reporting
		// success would tell the loser their tap did something.
		expect(outcome.status).toBe(409);
		expect(outcome.data.message.text).toBe('Someone already recorded that one.');
	});

	it('distinguishes an already-discarded row from an already-recorded one', async () => {
		discardCapture.mockRejectedValueOnce(new CaptureNotOpenError('discarded'));
		const outcome = (await discard({ captureId: 'cap-1' })) as {
			data: { message: { text: string } };
		};
		expect(outcome.data.message.text).toBe('Someone already discarded that one.');
	});

	it('answers an unknown id with a form failure, not a blown-away page', async () => {
		discardCapture.mockRejectedValueOnce(new CaptureNotFoundError());
		const outcome = (await discard({ captureId: 'nope' })) as {
			status: number;
			data: { message: { text: string } };
		};
		expect(outcome.status).toBe(404);
		expect(outcome.data.message.text).toBe('That note is no longer here.');
	});

	it('404s the page when the group itself is gone (§12 — never leak)', async () => {
		discardCapture.mockRejectedValueOnce(new GroupAccessError());
		const thrown = await discard({ captureId: 'cap-1' });
		expect(isHttpError(thrown)).toBe(true);
		expect((thrown as { status: number }).status).toBe(404);
	});

	it('never leaks the raw cause of an unexpected failure (§12)', async () => {
		discardCapture.mockRejectedValueOnce(new Error('connection terminated: secret-host:5432'));
		const outcome = (await discard({ captureId: 'cap-1' })) as {
			status: number;
			data: { message: { text: string } };
		};
		expect(outcome.status).toBe(500);
		expect(outcome.data.message.text).toBe('Could not discard that. Please try again.');
		expect(JSON.stringify(outcome.data)).not.toContain('secret-host');
	});
});
