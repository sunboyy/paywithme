import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { asEntryCurrencyCode } from '$lib/money';
import Page from './+page.svelte';
import type { PageData } from './$types';

// Display tests for the group OVERVIEW's "Recent transactions" card (issue #69
// finding 2; PLAN §7.6 Display, §7.5.2).
//
// The overview shows the five newest rows with their ORIGINAL amount, exactly as
// the full list does — and therefore has exactly the same obligation: a row's entry
// currency may be one the group defined itself, which exists ONLY as a `currencies`
// row. `formatAmount` throws on such a bare code by design (guessing an exponent
// would render every amount at the wrong scale), so before this fix the overview
// 500'd the moment a custom-currency transaction was among the five most recent.
// That is ordinary use of the feature — no race, no bad input.

vi.mock('$app/paths', () => ({
	resolve: (path: string, params?: Record<string, string>) =>
		params ? path.replace(/\[(\w+)\]/g, (_, k) => params[k] ?? `[${k}]`) : path
}));

/** The group's own custom currency: opaque PK, member-typed display code, 0-dp. */
const BEER = { code: 'cur_beer', displayCode: 'BEER', symbol: '🍺', exponent: 0 };

type RecentItem = PageData['recentTransactions'][number];

function txn(overrides: Partial<RecentItem> = {}): RecentItem {
	return {
		id: 't1',
		type: 'spending',
		title: 'Dinner',
		createdBy: 'u1',
		categoryId: 'spending-food-drink',
		categoryName: 'Food & Drink',
		categoryIcon: 'utensils',
		amountTotal: 9000,
		currency: 'THB',
		amountTotalSettlement: 9000,
		settlementCurrency: 'THB',
		isForeign: false,
		createdAt: '2026-08-01T12:00:00.000Z',
		occurredAt: '2026-08-01T12:00:00.000Z',
		...overrides
	} as RecentItem;
}

function pageData(
	recentTransactions: RecentItem[],
	recentCurrencies: PageData['recentCurrencies']
): PageData {
	return {
		group: { id: 'g1', name: 'Trip', settlementCurrency: 'THB' },
		summary: null,
		currency: { code: 'THB', symbol: '฿', exponent: 2 },
		balances: [],
		recentTransactions,
		recentCurrencies,
		recentActivity: []
	} as unknown as PageData;
}

afterEach(cleanup);

describe('group overview — a recent row recorded in a CUSTOM currency (issue #69)', () => {
	/** 3 BEER @ ฿250 = ฿750.00 — a 0-dp custom entry currency, foreign by definition. */
	const beerRow = txn({
		id: 't-beer',
		title: 'Round of beers',
		amountTotal: 3,
		currency: asEntryCurrencyCode(BEER.code),
		amountTotalSettlement: 75_000,
		isForeign: true
	});

	it('renders instead of throwing on a code the seeded constant cannot resolve', () => {
		// The bug was an EXCEPTION at render, so this is the assertion that bites.
		expect(() => render(Page, { props: { data: pageData([beerRow], [BEER]) } })).not.toThrow();
	});

	it('shows the DISPLAY code and never the opaque one', () => {
		const { container } = render(Page, { props: { data: pageData([beerRow], [BEER]) } });
		expect(container.textContent).toContain('BEER');
		expect(container.textContent).not.toContain('cur_beer');
	});

	it('shows the original amount at the CUSTOM exponent, with the settlement equivalent', () => {
		const { container } = render(Page, { props: { data: pageData([beerRow], [BEER]) } });
		// 0-dp: three beers read as "3", not "3.00" — the exponent came off the row.
		expect(container.textContent).toContain('BEER 🍺3');
		expect(container.textContent).not.toContain('🍺3.00');
		// …and the settlement equivalent as secondary text, in the group currency.
		expect(container.textContent).toContain('฿750.00');
	});

	it('leaves a seeded-currency row exactly as it was (regression)', () => {
		const seeded = [
			{ code: 'THB', displayCode: 'THB', symbol: '฿', exponent: 2 },
			{ code: 'JPY', displayCode: 'JPY', symbol: '¥', exponent: 0 }
		];
		const { container } = render(Page, {
			props: {
				data: pageData(
					[
						txn(),
						txn({
							id: 't-jpy',
							title: 'Ramen',
							amountTotal: 1000,
							currency: 'JPY',
							amountTotalSettlement: 22_000,
							isForeign: true
						})
					],
					seeded
				)
			}
		});
		// Same-currency row: bare symbol, no code (the group states it once).
		expect(container.textContent).toContain('฿90.00');
		// Foreign seeded row: keeps its ISO code so the two are never confusable.
		expect(container.textContent).toContain('JPY ¥1,000');
	});
});
