import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { asEntryCurrencyCode } from '$lib/money';
import Page from './+page.svelte';
import type { PageData } from './$types';

// Display tests for the group transaction LIST (issue #63; PLAN §7.6 Display,
// §7.5.2, §10).
//
// §7.6 says a list row shows the ORIGINAL amount in the currency it was recorded
// in, with the settlement equivalent as secondary text. Once a group can define
// its own currency that becomes load-bearing in two ways at once:
//
//   - the row's entry currency may be one that exists ONLY as a `currencies` row,
//     so formatting it from its bare code throws — the resolved descriptor has to
//     reach the page;
//   - that row's primary key is an opaque `cur_…` id, and the ONLY code a user may
//     ever read is its `display_code`.
//
// A seeded-currency row must be untouched by either.

vi.mock('$app/paths', () => ({
	resolve: (path: string, params?: Record<string, string>) =>
		params ? path.replace(/\[(\w+)\]/g, (_, k) => params[k] ?? `[${k}]`) : path
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

/** The group's own custom currency: opaque PK, member-typed display code, 0-dp. */
const BEER = { code: 'cur_beer', displayCode: 'BEER', symbol: '🍺', exponent: 0 };

type ListItem = PageData['transactions'][number];

function txn(overrides: Partial<ListItem> = {}): ListItem {
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
	} as ListItem;
}

function pageData(transactions: ListItem[]): PageData {
	return {
		group: { id: 'g1', name: 'Trip', settlementCurrency: 'THB' },
		currency: { code: 'THB', displayCode: 'THB', symbol: '฿', exponent: 2 },
		currencies: [
			{ code: 'THB', displayCode: 'THB', symbol: '฿', exponent: 2 },
			{ code: 'JPY', displayCode: 'JPY', symbol: '¥', exponent: 0 },
			BEER
		],
		transactions,
		members: [{ id: 'm1', displayName: 'Alex', isSelf: true, isInactive: false }],
		filters: { type: null, category: null, member: null, role: null },
		categories: {
			spending: [{ id: 'spending-food-drink', name: 'Food & Drink', icon: 'utensils' }],
			transfer: [{ id: 'transfer-cash', name: 'Cash', icon: 'banknote' }]
		}
	} as unknown as PageData;
}

afterEach(cleanup);

describe('transaction list — a row recorded in a CUSTOM currency (§7.6 Display)', () => {
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
		expect(() => render(Page, { props: { data: pageData([beerRow]) } })).not.toThrow();
	});

	it('shows the DISPLAY code and never the opaque one', () => {
		const { container } = render(Page, { props: { data: pageData([beerRow]) } });
		expect(container.textContent).toContain('BEER');
		expect(container.textContent).not.toContain('cur_beer');
	});

	it('shows the original amount at the CUSTOM exponent, with the settlement equivalent', () => {
		const { container } = render(Page, { props: { data: pageData([beerRow]) } });
		// 0-dp: three beers read as "3", not "3.00" — the exponent came off the row.
		expect(container.textContent).toContain('BEER 🍺3');
		expect(container.textContent).not.toContain('🍺3.00');
		// …and the settlement equivalent as secondary text, in the group currency.
		expect(container.textContent).toContain('฿750.00');
	});

	it('leaves a seeded-currency row exactly as it was (regression)', () => {
		const { container } = render(Page, {
			props: {
				data: pageData([
					txn(),
					txn({
						id: 't-jpy',
						title: 'Ramen',
						amountTotal: 1000,
						currency: 'JPY',
						amountTotalSettlement: 22_000,
						isForeign: true
					})
				])
			}
		});
		// Same-currency row: bare symbol, no code (the group states it once).
		expect(container.textContent).toContain('฿90.00');
		// Foreign SEEDED row: code-prefixed original + settlement equivalent.
		expect(container.textContent).toContain('JPY ¥1,000');
		expect(container.textContent).toContain('฿220.00');
	});
});
