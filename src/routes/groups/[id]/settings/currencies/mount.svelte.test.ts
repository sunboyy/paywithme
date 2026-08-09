import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { defaults } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import {
	createCustomCurrencySchema,
	customCurrencyRefSchema,
	editCustomCurrencySchema
} from '$lib/schemas/custom-currency';
import Page from './+page.svelte';
import type { PageData } from './$types';

// Client tests for the manage-custom-currencies screen (issue #62; PLAN §7.5.2,
// §10; ADR-0014).
//
// The page mounts the real superForms and the real field components, so these
// assert the whole screen's contract rather than a component in isolation:
//   - THE NOTICE. "Balances are always shown in <settlement currency>" is the one
//     piece of copy on this screen that has to be right — a user asking for a
//     custom currency has most likely assumed the opposite, and finding out after
//     ten transactions is the bad outcome (ADR-0014 "Consequences"). It names the
//     group's ACTUAL settlement currency, not a placeholder.
//   - the read-only-once-referenced rendering, per row;
//   - delete offered only while unreferenced, with a reason when it isn't;
//   - the live preview showing the ledger's code-prefixing rule.

vi.mock('$app/paths', () => ({
	resolve: (path: string, params?: Record<string, string>) =>
		params ? path.replace(/\[(\w+)\]/g, (_, k) => params[k] ?? `[${k}]`) : path
}));

type PageCurrency = PageData['currencies'][number];

const BEER: PageCurrency = {
	code: 'cur_beer',
	displayCode: 'BEER',
	name: 'Bottle of beer',
	symbol: '🍺',
	exponent: 0,
	isReferenced: false
};

/** Page data mirroring what `currencies/+page.server.ts` provides. */
function pageData(currencies: PageCurrency[] = []): PageData {
	return {
		group: { id: 'g1', name: 'Trip' },
		settlement: { displayCode: 'THB', name: 'Thai Baht', symbol: '฿' },
		currencies,
		createForm: defaults(zod4(createCustomCurrencySchema)),
		editForm: defaults(zod4(editCustomCurrencySchema)),
		deleteForm: defaults(zod4(customCurrencyRefSchema))
	} as PageData;
}

afterEach(cleanup);

describe('manage-custom-currencies screen', () => {
	it('mounts and renders the add form', () => {
		const { container } = render(Page, { props: { data: pageData() } });
		expect(container.querySelector('form[action="?/create"]')).not.toBeNull();
		expect(container.textContent).toContain('Add a currency');
	});

	it('says the entry-only limit out loud, naming the settlement currency', () => {
		const { getByTestId } = render(Page, { props: { data: pageData() } });
		// Collapse the source's line wrapping — the sentence is what matters.
		const notice = (getByTestId('settlement-currency-notice').textContent ?? '')
			.replace(/\s+/g, ' ')
			.trim();

		expect(notice).toContain('Balances are always shown in');
		expect(notice).toContain('THB');
		expect(notice).toContain('Thai Baht');
		expect(notice).toContain('A custom currency is for recording a transaction');
		expect(notice).toContain('the group still settles in THB');
	});

	it('shows a nothing-yet nudge when the group has no custom currencies', () => {
		const { getByTestId } = render(Page, { props: { data: pageData() } });
		expect(getByTestId('currencies-empty').textContent).toContain('No custom currencies yet');
	});

	it("lists the group's currencies by DISPLAY code, never the opaque one", () => {
		const { container } = render(Page, { props: { data: pageData([BEER]) } });

		expect(container.textContent).toContain('BEER');
		expect(container.textContent).toContain('Bottle of beer');
		expect(container.textContent).not.toContain('cur_beer');
		// The opaque code IS present, but only as the hidden field naming the target.
		const hidden = container.querySelector('form[action="?/edit"] input[name="code"]');
		expect(hidden?.getAttribute('value')).toBe('cur_beer');
	});

	it('keeps every field editable and offers delete for an UNREFERENCED currency', () => {
		const { container } = render(Page, { props: { data: pageData([BEER]) } });

		const code = container.querySelector('#edit-cur_beer-displayCode') as HTMLInputElement;
		expect(code.readOnly).toBe(false);
		expect(container.querySelector('select#edit-cur_beer-exponent')).not.toBeNull();
		expect(container.querySelector('form[action="?/delete"]')).not.toBeNull();
	});

	it('freezes the code and decimal places, and withdraws delete, once REFERENCED', () => {
		const referenced = { ...BEER, isReferenced: true };
		const { container, getByTestId } = render(Page, { props: { data: pageData([referenced]) } });

		const code = container.querySelector('#edit-cur_beer-displayCode') as HTMLInputElement;
		expect(code.readOnly).toBe(true);
		expect(container.querySelector('select#edit-cur_beer-exponent')).toBeNull();
		expect(getByTestId('edit-cur_beer-exponent-readonly')).not.toBeNull();

		// No delete form at all — and a reason instead of a button that always fails.
		expect(container.querySelector('form[action="?/delete"]')).toBeNull();
		expect(getByTestId('edit-cur_beer-delete-blocked').textContent).toContain("can't be deleted");

		// name / symbol stay editable (ADR-0014 decision 5).
		expect((container.querySelector('#edit-cur_beer-name') as HTMLInputElement).readOnly).toBe(
			false
		);
		expect((container.querySelector('#edit-cur_beer-symbol') as HTMLInputElement).readOnly).toBe(
			false
		);
	});

	it('previews a row code-prefixed when its symbol collides with a seeded one', () => {
		const collides: PageCurrency = {
			code: 'cur_usd',
			displayCode: 'MYUSD',
			name: 'Old dollars',
			symbol: '$',
			exponent: 2,
			isReferenced: false
		};
		const { getByTestId } = render(Page, { props: { data: pageData([collides]) } });

		// Through `formatAmount`, so the ledger's rule shows here first: a custom
		// currency always disambiguates (ADR-0014 decision 4).
		expect(getByTestId('edit-cur_usd-preview-value').textContent).toBe('MYUSD $1,234.56');
	});
});
