import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for the custom-currency USAGE read (issue #62; PLAN §7.5.2;
// ADR-0014 decision 5).
//
// STRATEGY: no real DB. `listCurrenciesForGroup` (the #61 service) and the `db`
// handle are both stubbed, so what these tests pin down is this module's own
// contract:
//   - only the group's OWN custom rows come back (never the seeded 29);
//   - each is flagged with whether a transaction already references it;
//   - the reference lookup is ONE query over all of the group's codes, and is
//     skipped entirely when the group has no custom currencies;
//   - a `GroupAccessError` from the access-checked list is propagated, not
//     swallowed (§12 — the route turns it into a 404).

const { listCurrenciesForGroup, selectDistinct, state } = vi.hoisted(() => {
	const state = {
		/** Rows the next `selectDistinct(...)` resolves to. */
		referencedRows: [] as { currency: string }[],
		/** Codes passed to the `inArray(...)` filter, recorded per call. */
		whereCalls: [] as unknown[]
	};
	const selectDistinct = vi.fn(() => {
		const chain: Record<string, unknown> = {};
		chain.from = () => chain;
		chain.where = (w: unknown) => {
			state.whereCalls.push(w);
			return chain;
		};
		chain.then = (resolve: (v: unknown) => unknown) => resolve(state.referencedRows);
		return chain;
	});
	return { listCurrenciesForGroup: vi.fn(), selectDistinct, state };
});

vi.mock('./db', () => ({ db: { selectDistinct } }));
vi.mock('./currencies', () => ({ listCurrenciesForGroup }));

import { listCustomCurrenciesWithUsage } from './currency-usage';

/** A `currencies` row as `listCurrenciesForGroup` returns it. */
function row(code: string, displayCode: string, isCustom: boolean) {
	return {
		code,
		displayCode,
		name: displayCode,
		symbol: '¤',
		exponent: 2,
		groupId: isCustom ? 'g1' : null,
		createdBy: null,
		createdAt: null,
		isCustom
	};
}

const SEEDED = row('THB', 'THB', false);
const BEER = row('cur_beer', 'BEER', true);
const ROUND = row('cur_round', 'ROUND', true);

beforeEach(() => {
	listCurrenciesForGroup.mockReset();
	selectDistinct.mockClear();
	state.referencedRows = [];
	state.whereCalls = [];
});

describe('listCustomCurrenciesWithUsage', () => {
	it("returns only the group's own custom rows, never the seeded ones", async () => {
		listCurrenciesForGroup.mockResolvedValue([SEEDED, BEER, ROUND]);

		const result = await listCustomCurrenciesWithUsage({ userId: 'u1', groupId: 'g1' });

		expect(result.map((c) => c.displayCode)).toEqual(['BEER', 'ROUND']);
	});

	it('flags the referenced rows and only those', async () => {
		listCurrenciesForGroup.mockResolvedValue([SEEDED, BEER, ROUND]);
		state.referencedRows = [{ currency: 'cur_beer' }];

		const result = await listCustomCurrenciesWithUsage({ userId: 'u1', groupId: 'g1' });

		expect(result.find((c) => c.displayCode === 'BEER')?.isReferenced).toBe(true);
		expect(result.find((c) => c.displayCode === 'ROUND')?.isReferenced).toBe(false);
	});

	it('asks the database once, not once per currency', async () => {
		listCurrenciesForGroup.mockResolvedValue([BEER, ROUND]);

		await listCustomCurrenciesWithUsage({ userId: 'u1', groupId: 'g1' });

		expect(selectDistinct).toHaveBeenCalledTimes(1);
	});

	it('skips the reference query entirely when the group has no custom currencies', async () => {
		listCurrenciesForGroup.mockResolvedValue([SEEDED]);

		const result = await listCustomCurrenciesWithUsage({ userId: 'u1', groupId: 'g1' });

		expect(result).toEqual([]);
		expect(selectDistinct).not.toHaveBeenCalled();
	});

	it('propagates the access failure from the access-checked list (§12)', async () => {
		class GroupAccessError extends Error {}
		listCurrenciesForGroup.mockRejectedValue(new GroupAccessError('no access'));

		await expect(listCustomCurrenciesWithUsage({ userId: 'u1', groupId: 'g1' })).rejects.toThrow(
			GroupAccessError
		);
		expect(selectDistinct).not.toHaveBeenCalled();
	});
});
