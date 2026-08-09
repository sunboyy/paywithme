import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for the READ-side entry-currency resolver (issue #64; PLAN §7.5.2;
// ADR-0014 decision 7).
//
// Two things are under test, and the second is the one a reviewer should care
// about most:
//
//   1. CORRECTNESS — a seeded code resolves from the compiled-in table, a custom
//      code resolves to the group's row (display code, exponent, symbol, name and
//      author), and a code that belongs to neither THROWS rather than degrading
//      into something that would put an opaque `cur_…` on the wire.
//   2. QUERY COUNT — the whole point of resolving a PAGE at a time. An all-seeded
//      page issues NO query; a page with any number of custom rows issues exactly
//      ONE. The `db.select` spy is asserted on directly, because "no N+1" is a
//      claim about calls, not about output.
//
// STRATEGY: no real DB — `./db` is stubbed with a thenable query chain, so these
// tests pin this module's own contract and nothing else.

const { select, state } = vi.hoisted(() => {
	const state = {
		/** Rows the next `select(...)` resolves to. */
		rows: [] as Record<string, unknown>[]
	};
	const select = vi.fn(() => {
		const chain: Record<string, unknown> = {};
		chain.from = () => chain;
		chain.where = () => chain;
		chain.then = (resolve: (v: unknown) => unknown) => resolve(state.rows);
		return chain;
	});
	return { select, state };
});

vi.mock('./db', () => ({ db: { select } }));

import { resolveEntryCurrencies, resolveEntryCurrency } from './entry-currency';

/** A custom `currencies` row as the query selects it. */
const BEER = {
	code: 'cur_beer',
	displayCode: 'BEER',
	name: 'Bottle of beer',
	exponent: 0,
	symbol: '🍺',
	createdBy: 'user_mal'
};
const ROUND = {
	code: 'cur_round',
	displayCode: 'ROUND',
	name: 'Round of drinks',
	exponent: 2,
	symbol: 'R',
	createdBy: null
};

beforeEach(() => {
	select.mockClear();
	state.rows = [];
});

describe('resolveEntryCurrencies — the seeded fast path (no query)', () => {
	it('resolves seeded codes from the compiled-in table WITHOUT touching the database', async () => {
		const lookup = await resolveEntryCurrencies('grp_1', ['THB', 'JPY', 'THB']);

		// THE N+1 GUARD, in its strongest form: the ordinary page costs nothing at all.
		expect(select).not.toHaveBeenCalled();
		expect(lookup('THB')).toEqual({
			code: 'THB',
			displayCode: 'THB',
			name: 'Thai Baht',
			exponent: 2,
			symbol: '฿',
			createdBy: null
		});
		// A 0-decimal currency keeps its own exponent — nothing here assumes 2.
		expect(lookup('JPY').exponent).toBe(0);
	});

	it('a seeded row has no author: nobody wrote `THB`, so it can never be attributed', async () => {
		const lookup = await resolveEntryCurrencies('grp_1', ['USD']);
		expect(lookup('USD').createdBy).toBeNull();
		// `code == display_code` is the seeded-row invariant the whole design rests on.
		expect(lookup('USD').code).toBe(lookup('USD').displayCode);
	});

	it('an EMPTY page issues no query either', async () => {
		await resolveEntryCurrencies('grp_1', []);
		expect(select).not.toHaveBeenCalled();
	});
});

describe('resolveEntryCurrencies — custom currencies (ONE query for the page)', () => {
	it('resolves a custom code to its row: display code, exponent, symbol, name, author', async () => {
		state.rows = [BEER];
		const lookup = await resolveEntryCurrencies('grp_1', ['cur_beer']);

		expect(lookup('cur_beer')).toEqual({
			code: 'cur_beer',
			displayCode: 'BEER',
			name: 'Bottle of beer',
			exponent: 0,
			symbol: '🍺',
			createdBy: 'user_mal'
		});
	});

	it('issues EXACTLY ONE query for a whole page of mixed and repeated custom codes', async () => {
		state.rows = [BEER, ROUND];
		const page = ['THB', 'cur_beer', 'cur_beer', 'cur_round', 'JPY', 'cur_beer'];

		const lookup = await resolveEntryCurrencies('grp_1', page);

		// ONE query for six rows in four currencies — not one per row, and not one per
		// distinct custom code either.
		expect(select).toHaveBeenCalledTimes(1);
		expect(page.map((code) => lookup(code).displayCode)).toEqual([
			'THB',
			'BEER',
			'BEER',
			'ROUND',
			'JPY',
			'BEER'
		]);
	});

	it('a custom row with no recorded author resolves with `createdBy: null`', async () => {
		// `currencies.created_by` is `ON DELETE SET NULL`, so the author of a currency
		// whose account is gone is genuinely unknown — never guessed.
		state.rows = [ROUND];
		const lookup = await resolveEntryCurrencies('grp_1', ['cur_round']);
		expect(lookup('cur_round').createdBy).toBeNull();
	});
});

describe('resolveEntryCurrencies — an unresolvable code fails LOUDLY', () => {
	it('throws for a code the group cannot use, rather than degrading', async () => {
		// Another group's custom currency: the query is group-scoped, so it simply is
		// not in the result. The tempting fallbacks — display the opaque code, or invent
		// an exponent — are both worse than a throw (CONTEXT.md "Display code").
		state.rows = [BEER];
		const lookup = await resolveEntryCurrencies('grp_1', ['cur_other']);

		expect(() => lookup('cur_other')).toThrow(/not in this group's currency set/);
	});

	it('throws for a code that was never requested and is not seeded', async () => {
		const lookup = await resolveEntryCurrencies('grp_1', ['THB']);
		expect(() => lookup('cur_never_asked')).toThrow(/not in this group's currency set/);
		// A seeded code, though, still resolves — the lookup stays total over the 29.
		expect(lookup('EUR').displayCode).toBe('EUR');
	});
});

describe('resolveEntryCurrency — the single-transaction form', () => {
	it('resolves one seeded code with no query', async () => {
		const thb = await resolveEntryCurrency('grp_1', 'THB');
		expect(select).not.toHaveBeenCalled();
		expect(thb.displayCode).toBe('THB');
	});

	it('resolves one custom code with a single query', async () => {
		state.rows = [BEER];
		const beer = await resolveEntryCurrency('grp_1', 'cur_beer');
		expect(select).toHaveBeenCalledTimes(1);
		expect(beer.displayCode).toBe('BEER');
	});
});
