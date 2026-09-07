import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
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
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));

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

type Tray = PageData['captures'];

function pageData(transactions: ListItem[], captures: Tray = []): PageData {
	return {
		group: { id: 'g1', name: 'Trip', settlementCurrency: 'THB' },
		currency: { code: 'THB', displayCode: 'THB', symbol: '฿', exponent: 2 },
		currencies: [
			{ code: 'THB', displayCode: 'THB', symbol: '฿', exponent: 2 },
			{ code: 'JPY', displayCode: 'JPY', symbol: '¥', exponent: 0 },
			BEER
		],
		transactions,
		captures,
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
		expect(() => render(Page, { props: { data: pageData([beerRow]), form: null } })).not.toThrow();
	});

	it('shows the DISPLAY code and never the opaque one', () => {
		const { container } = render(Page, { props: { data: pageData([beerRow]), form: null } });
		expect(container.textContent).toContain('BEER');
		expect(container.textContent).not.toContain('cur_beer');
	});

	it('shows the original amount at the CUSTOM exponent, with the settlement equivalent', () => {
		const { container } = render(Page, { props: { data: pageData([beerRow]), form: null } });
		// 0-dp: three beers read as "3", not "3.00" — the exponent came off the row.
		expect(container.textContent).toContain('BEER 🍺3');
		expect(container.textContent).not.toContain('🍺3.00');
		// …and the settlement equivalent as secondary text, in the group currency.
		expect(container.textContent).toContain('฿750.00');
	});

	it('leaves a seeded-currency row exactly as it was (regression)', () => {
		const { container } = render(Page, {
			props: {
				form: null,
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

// ── The "Not recorded yet" tray (issue #50; PLAN §7.7, §10) ───────────────────
//
// The tray is above the list and shows the group's OPEN Captures. Three things
// about it are load-bearing rather than cosmetic:
//
//   1. `note` is MEMBER-AUTHORED TEXT (CONTEXT.md). It must reach the DOM as
//      TEXT, never as markup, and it must never be shown unattributed — the
//      tray's whole job is deduplication, which needs a name on the line.
//   2. Discarding is DESTRUCTIVE, so with JS it is gated by an Alert Dialog
//      naming the target (§10) — and the underlying real form action still has
//      to be there, because the dialog is only the guard, not the mechanism.
//   3. The word "Capture" is INTERNAL vocabulary (§7.7) and may not appear.

/** One open Capture, as `load` shapes it for the tray. */
function tray(overrides: Partial<Tray[number]> = {}): Tray[number] {
	return {
		id: 'cap-1',
		note: 'dinner at the night market',
		authorName: 'Sur',
		amountFormatted: '฿1,200.00',
		capturedFor: '2026-08-01',
		...overrides
	};
}

describe('the "Not recorded yet" tray', () => {
	it('is absent entirely when nothing is open (a tray, not an empty state)', () => {
		const { container } = render(Page, { props: { data: pageData([txn()]), form: null } });
		expect(container.querySelector('[data-testid="not-recorded-yet-tray"]')).toBeNull();
		expect(container.textContent).not.toContain('Not recorded yet');
	});

	it('shows each open note with its author and rough amount', () => {
		const { container } = render(Page, {
			props: { data: pageData([], [tray()]), form: null }
		});

		const el = container.querySelector('[data-testid="not-recorded-yet-tray"]');
		expect(el).not.toBeNull();
		expect(el?.textContent).toContain('dinner at the night market');
		// Attribution — the reason the tray deduplicates (§7.7).
		expect(el?.textContent).toContain('Sur');
		expect(el?.textContent).toContain('฿1,200.00');
	});

	it('renders a note-only Capture with no amount at all', () => {
		const { container } = render(Page, {
			props: { data: pageData([], [tray({ amountFormatted: null })]), form: null }
		});
		const el = container.querySelector('[data-testid="not-recorded-yet-tray"]');
		expect(el?.textContent).toContain('dinner at the night market');
		expect(el?.textContent).not.toContain('~');
	});

	it('ESCAPES member-authored note text instead of rendering it as markup', () => {
		const hostile = '<img src=x onerror="alert(1)"><b>bold</b>';
		const { container } = render(Page, {
			props: {
				data: pageData([], [tray({ note: hostile, authorName: '<i>Mallory</i>' })]),
				form: null
			}
		});

		const el = container.querySelector('[data-testid="not-recorded-yet-tray"]');
		// The markup never became nodes…
		expect(el?.querySelector('img')).toBeNull();
		expect(el?.querySelector('b')).toBeNull();
		expect(el?.querySelector('i')).toBeNull();
		// The angle brackets are escaped entities in the markup, so nothing the
		// member typed was ever parsed as HTML.
		expect(el?.innerHTML).toContain('&lt;img');
		expect(el?.innerHTML).not.toContain('<img');
		// …it stayed the literal characters the member typed, still attributed.
		expect(el?.textContent).toContain(hostile);
		expect(el?.textContent).toContain('<i>Mallory</i>');
	});

	it('confirms the discard with a dialog NAMING the note, escaped (§10)', async () => {
		const { container } = render(Page, {
			props: { data: pageData([], [tray({ note: '<b>taxi</b> to the airport' })]), form: null }
		});

		const trigger = container.querySelector<HTMLButtonElement>(
			'[data-slot="alert-dialog-trigger"]'
		);
		expect(trigger).not.toBeNull();
		await fireEvent.click(trigger!);

		// The content is PORTALED out of the form's subtree, so it is looked up on
		// the document rather than in the tray.
		const dialog = await waitFor(() => {
			const el = document.body.querySelector('[data-slot="alert-dialog-content"]');
			expect(el).not.toBeNull();
			return el!;
		});

		// It names the specific target — a single mis-tap can't discard the wrong
		// note — and names it as TEXT.
		expect(dialog.textContent).toContain('<b>taxi</b> to the airport');
		expect(dialog.querySelector('b')).toBeNull();
		// Cancel + a visually distinct destructive confirm (§10).
		expect(dialog.textContent).toContain('Cancel');
		expect(dialog.querySelector('[data-slot="alert-dialog-action"]')).not.toBeNull();
	});

	// "Record it" (issue #51; PLAN §7.7 "Resolving") — the OTHER ending. A plain
	// link, carrying only the note's id: the add-transaction form re-reads the row
	// and prefills itself server-side, so a link can never dictate what gets recorded.
	it('offers "Record it" as a link to the prefilled add-transaction form', () => {
		const { container } = render(Page, {
			props: { data: pageData([], [tray()]), form: null }
		});
		const el = container.querySelector('[data-testid="not-recorded-yet-tray"]');

		const link = el?.querySelector('a[href*="capture="]');
		expect(link?.getAttribute('href')).toBe('/groups/g1/transactions/new?capture=cap-1');
		expect(link?.textContent).toContain('Record it');
	});

	it('posts discard through a REAL form action, gated by an Alert Dialog', () => {
		const { container } = render(Page, {
			props: { data: pageData([], [tray()]), form: null }
		});
		const el = container.querySelector('[data-testid="not-recorded-yet-tray"]');

		// The mechanism: a real POST to the route's own action, carrying the id.
		const form = el?.querySelector('form');
		expect(form?.getAttribute('method')?.toUpperCase()).toBe('POST');
		expect(form?.getAttribute('action')).toBe('?/discard');
		const hidden = form?.querySelector('input[type="hidden"]');
		expect(hidden?.getAttribute('name')).toBe('captureId');
		expect(hidden?.getAttribute('value')).toBe('cap-1');

		// The guard: post-mount the button is an Alert Dialog trigger, not a submit.
		const trigger = el?.querySelector('[data-slot="alert-dialog-trigger"]');
		expect(trigger).not.toBeNull();
		expect(trigger?.getAttribute('type')).toBe('button');
	});

	it('keeps the active filter on the discard action, so a no-JS post comes back to it', () => {
		const data = pageData([], [tray()]);
		data.filters = { type: 'spending', category: null, member: 'm1', role: 'paid' };

		const { container } = render(Page, { props: { data, form: null } });

		const action = container
			.querySelector('[data-testid="not-recorded-yet-tray"] form')
			?.getAttribute('action');
		// The action param comes first (SvelteKit reads the key starting with `/`),
		// with the filter riding along instead of being replaced by it.
		expect(action).toBe('?/discard&type=spending&member=m1&role=paid');
	});

	it('never says the internal word "capture" (§7.7 naming)', () => {
		const { container } = render(Page, {
			props: { data: pageData([txn()], [tray()]), form: null }
		});
		expect(container.textContent?.toLowerCase()).not.toContain('capture');
	});
});
