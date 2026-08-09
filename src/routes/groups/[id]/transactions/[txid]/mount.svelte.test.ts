import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { defaults } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { buildTransactionSchema } from '$lib/schemas/transaction';
import Page from './+page.svelte';
import type { PageData } from './$types';

// Display tests for the single-transaction VIEW (issue #63; PLAN §7.6 Display,
// §7.5.2, §10).
//
// The detail page renders the ORIGINAL amount in the transaction's own entry
// currency, plus the settlement equivalent and the "rate via X → Y" line. When
// that entry currency is one the group defined itself, both halves of ADR-0014
// decision 4 have to hold: the amount is formatted from the RESOLVED row (its code
// resolves nowhere else), and the only code on screen is its `display_code`.

vi.mock('$app/paths', () => ({
	resolve: (path: string, params?: Record<string, string>) =>
		params ? path.replace(/\[(\w+)\]/g, (_, k) => params[k] ?? `[${k}]`) : path
}));

/** The group's own custom currency: opaque PK, member-typed display code, 0-dp. */
const BEER = { code: 'cur_beer', displayCode: 'BEER', symbol: '🍺', exponent: 0 };
const THB = { code: 'THB', displayCode: 'THB', symbol: '฿', exponent: 2 };

const schema = buildTransactionSchema({ settlementCurrency: 'THB', memberIds: ['m1', 'm2'] });

/**
 * 3 BEER at ฿250 = ฿750.00, split between two members. Amounts on the entry side
 * are in BEER minor units (0-dp); resolved shares are settlement satang (§7.6).
 */
function beerDetail(): PageData['detail'] {
	return {
		id: 't1',
		groupId: 'g1',
		type: 'spending',
		title: 'Round of beers',
		categoryId: 'spending-food-drink',
		categoryName: 'Food & Drink',
		categoryIcon: 'utensils',
		createdBy: 'u1',
		amountTotal: 3,
		currency: BEER.code,
		amountTotalSettlement: 75_000,
		settlementCurrency: 'THB',
		isForeign: true,
		splitMode: 'equal',
		createdAt: '2026-08-01T12:00:00.000Z',
		deletedAt: null,
		payers: [{ memberId: 'm1', amountPaid: 3 }],
		shares: [
			{ memberId: 'm1', amountOwed: 37_500 },
			{ memberId: 'm2', amountOwed: 37_500 }
		],
		items: [],
		charges: [],
		input: {
			type: 'spending',
			title: 'Round of beers',
			date: '2026-08-01',
			categoryId: 'spending-food-drink',
			amountTotal: 3,
			currency: BEER.code,
			exchangeRate: '250',
			amountTotalSettlement: 75_000,
			splitMode: 'equal',
			payers: [{ memberId: 'm1', amountPaid: 3 }],
			beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }],
			items: [],
			charges: []
		}
	} as unknown as PageData['detail'];
}

function pageData(detail: PageData['detail'], entryCurrency = BEER): PageData {
	return {
		detail,
		history: [],
		memberNames: { m1: 'Alex', m2: 'Bo' },
		group: { id: 'g1', name: 'Trip', settlementCurrency: 'THB' },
		currency: THB,
		entryCurrency,
		currencies: [THB, { ...BEER, name: 'Bottle of beer' }],
		members: [
			{ id: 'm1', displayName: 'Alex', isLinked: true },
			{ id: 'm2', displayName: 'Bo', isLinked: false }
		],
		categories: {
			spending: [{ id: 'spending-food-drink', name: 'Food & Drink', icon: 'utensils' }],
			transfer: [{ id: 'transfer-cash', name: 'Cash', icon: 'banknote' }]
		},
		form: defaults(zod4(schema))
	} as unknown as PageData;
}

afterEach(cleanup);

describe('transaction detail — a CUSTOM entry currency (§7.6 Display / §7.5.2)', () => {
	it('renders instead of throwing on a code the seeded constant cannot resolve', () => {
		expect(() => render(Page, { props: { data: pageData(beerDetail()) } })).not.toThrow();
	});

	it('shows the original amount at the custom exponent, prefixed by its DISPLAY code', () => {
		const { container } = render(Page, { props: { data: pageData(beerDetail()) } });
		// 0-dp, and always disambiguated: a member-authored symbol can't be assumed
		// unique, so "🍺3" alone would be ambiguous (ADR-0014 decision 4).
		expect(container.textContent).toContain('BEER 🍺3');
		expect(container.textContent).not.toContain('🍺3.00');
	});

	it('never puts the opaque code on screen — including in the FX line', () => {
		const { container } = render(Page, { props: { data: pageData(beerDetail()) } });
		expect(container.textContent).not.toContain('cur_beer');
		// The §7.6 secondary line names the conversion by display code.
		expect(container.textContent).toContain('฿750.00');
		expect(container.textContent).toContain('BEER');
		expect(container.textContent).toContain('THB');
	});

	it('shows payer amounts in the entry currency and owed in the settlement currency', () => {
		const { container } = render(Page, { props: { data: pageData(beerDetail()) } });
		// Payer paid 3 BEER…
		expect(container.textContent).toContain('BEER 🍺3');
		// …and each member owes half of the settlement total.
		expect(container.textContent).toContain('฿375.00');
	});

	it('a SEEDED same-currency transaction is unchanged (regression)', () => {
		const detail = {
			...beerDetail(),
			amountTotal: 9000,
			currency: 'THB',
			amountTotalSettlement: 9000,
			isForeign: false,
			payers: [{ memberId: 'm1', amountPaid: 9000 }],
			shares: [
				{ memberId: 'm1', amountOwed: 4500 },
				{ memberId: 'm2', amountOwed: 4500 }
			]
		} as unknown as PageData['detail'];
		const { container } = render(Page, { props: { data: pageData(detail, THB) } });
		// Context-established currency: a bare symbol, no code prefix.
		expect(container.textContent).toContain('฿90.00');
		expect(container.textContent).not.toContain('THB ฿90.00');
		expect(container.textContent).not.toContain('cur_beer');
	});
});
