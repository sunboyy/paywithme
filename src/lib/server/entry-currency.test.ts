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

import {
	resolveEntryCurrencies,
	resolveEntryCurrency,
	resolveWriteCurrency,
	resolveWriteCurrencyCode
} from './entry-currency';

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

// ── THE WRITE DIRECTION (issue #68; ADR-0014 decision 8) ─────────────────────
//
// The inverse mapping: a display code off the wire → the `currencies.code` the
// ledger stores. What matters here is not just that `BEER` resolves, but that
// EVERY way of failing to resolve produces the SAME unusable value, so the service's
// own gate rejects it with the one shared message (PLAN §7.5.2) — no new error
// class, nothing distinguishable about "unknown", "another group's", or "you sent
// the internal key".

describe('resolveWriteCurrencyCode — display code → internal currency key', () => {
	it('a seeded code is its own key, and costs no query', async () => {
		expect(await resolveWriteCurrencyCode('grp_1', 'THB')).toBe('THB');
		expect(await resolveWriteCurrencyCode('grp_1', 'JPY')).toBe('JPY');
		// The seeded invariant `code == display_code` makes the translation the
		// identity, so an existing client's body needs no database round-trip at all.
		expect(select).not.toHaveBeenCalled();
	});

	it("resolves this group's own display code to its OPAQUE key, in one query", async () => {
		state.rows = [BEER, ROUND];
		expect(await resolveWriteCurrencyCode('grp_1', 'BEER')).toBe('cur_beer');
		expect(select).toHaveBeenCalledTimes(1);
	});

	it('another group\'s display code resolves to nothing — no "which group" signal', async () => {
		// The query is group-scoped, so another group's `BEER` row is simply not in the
		// result set. It has to fail like an invention, not like "exists elsewhere".
		state.rows = [];
		expect(await resolveWriteCurrencyCode('grp_1', 'BEER')).toBe('');
	});

	it('an unknown code and a wrong-case code resolve to nothing', async () => {
		state.rows = [BEER];
		expect(await resolveWriteCurrencyCode('grp_1', 'XXX')).toBe('');
		expect(await resolveWriteCurrencyCode('grp_1', 'thb')).toBe('');
		expect(await resolveWriteCurrencyCode('grp_1', '')).toBe('');
	});

	it('REJECTS the opaque key itself — the write vocabulary is display code only', async () => {
		// The load-bearing case (ADR-0014 decision 8). A client that somehow learned
		// `cur_beer` must NOT be able to write with it: accepting both vocabularies would
		// make the internal identifier a de-facto part of the contract, which is exactly
		// what publishing-by-accident would cost us.
		state.rows = [BEER];
		expect(await resolveWriteCurrencyCode('grp_1', 'cur_beer')).toBe('');
	});
});

describe('resolveWriteCurrency — the write body', () => {
	const body = {
		type: 'spending',
		title: 'Three beers',
		amountTotal: 3,
		currency: 'BEER',
		exchangeRate: '250'
	};

	it('substitutes the internal key and leaves every other field untouched', async () => {
		state.rows = [BEER];
		const translated = (await resolveWriteCurrency('grp_1', body)) as Record<string, unknown>;

		expect(translated).toEqual({ ...body, currency: 'cur_beer' });
		// The input is not mutated — the raw body a caller may still fingerprint (§16.6)
		// keeps saying what the client said.
		expect(body.currency).toBe('BEER');
	});

	it('forwards a seeded-currency body AS THE SAME OBJECT (no copy, no change)', async () => {
		const seeded = { ...body, currency: 'THB' };
		expect(await resolveWriteCurrency('grp_1', seeded)).toBe(seeded);
		expect(select).not.toHaveBeenCalled();
	});

	it('rewrites an unresolvable code to a value no group set can contain', async () => {
		// It must not pass the original through: the service builds its gate from the
		// group's rows keyed by `code`, so an opaque key left intact would VALIDATE.
		state.rows = [BEER];
		const translated = (await resolveWriteCurrency('grp_1', {
			...body,
			currency: 'cur_beer'
		})) as Record<string, unknown>;
		expect(translated.currency).toBe('');
	});

	it('passes through a body with no string `currency` for the schema to reject', async () => {
		// Nothing to translate, and the shared schema already answers these with the same
		// message — inventing a second rejection path here would only add a way to differ.
		const missing = { type: 'spending' };
		expect(await resolveWriteCurrency('grp_1', missing)).toBe(missing);
		const wrongType = { currency: 42 };
		expect(await resolveWriteCurrency('grp_1', wrongType)).toBe(wrongType);
		expect(await resolveWriteCurrency('grp_1', null)).toBeNull();
		expect(await resolveWriteCurrency('grp_1', 'nonsense')).toBe('nonsense');
		expect(select).not.toHaveBeenCalled();
	});
});
