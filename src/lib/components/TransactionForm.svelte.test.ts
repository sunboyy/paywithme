import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { defaults } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { buildTransactionSchema, type TransactionInput } from '$lib/schemas/transaction';
import type { SuperForm } from 'sveltekit-superforms';
import type { FormMember, FormCategory, FormCurrency } from './TransactionForm.svelte';
import TransactionFormHarness from './TransactionFormHarness.svelte';

// Client (jsdom) a11y tests for the shared <TransactionForm/> (task 8.3; PLAN §10).
//
// Focus of the pass: every dynamically-added row input must carry a row-specific
// ACCESSIBLE NAME (an item amount belongs to "Item 2"; a per-member share names
// the member), the select controls must be named, and an errored input must
// expose its message to AT via aria-invalid + aria-describedby.
//
// superForm() registers an onDestroy, so it can only be created during component
// init — the small TransactionFormHarness builds it inside a component and renders
// <TransactionForm/> exactly as a route page does.

const SETTLEMENT = 'THB';

const members: FormMember[] = [
	{ id: 'm-alex', displayName: 'Alex', isLinked: true },
	{ id: 'm-bo', displayName: 'Bo', isLinked: false }
];

const categories: { spending: FormCategory[]; transfer: FormCategory[] } = {
	spending: [{ id: 'spending-food', name: 'Food & drink', icon: 'utensils' }],
	transfer: [{ id: 'transfer-debt-settlement', name: 'Debt settlement', icon: 'handshake' }]
};

const currency: FormCurrency = { code: 'THB', symbol: '฿', exponent: 2, name: 'Thai Baht' };

const schema = buildTransactionSchema({
	settlementCurrency: SETTLEMENT,
	memberIds: members.map((m) => m.id)
});

function seededFor(overrides: Partial<TransactionInput> = {}) {
	const base = defaults(zod4(schema));
	return {
		...base,
		data: {
			...base.data,
			type: 'spending',
			categoryId: 'spending-food',
			currency: SETTLEMENT,
			exchangeRate: '1',
			...overrides
		} satisfies TransactionInput
	};
}

function renderForm(overrides: Partial<TransactionInput> = {}) {
	let form!: SuperForm<TransactionInput>;
	const result = render(TransactionFormHarness, {
		props: {
			seeded: seededFor(overrides),
			members,
			categories,
			currency,
			onform: (f) => (form = f)
		}
	});
	return { form, ...result };
}

afterEach(() => cleanup());

describe('TransactionForm a11y', () => {
	it('names the per-item amount + label inputs by their row', () => {
		const { container } = renderForm({
			splitMode: 'itemized',
			items: [
				{ label: 'Pizza', amount: 0, splitMode: 'equal', beneficiaries: [] },
				{ label: 'Salad', amount: 0, splitMode: 'equal', beneficiaries: [] }
			]
		});
		expect(container.querySelector('[aria-label="Item 1 amount"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="Item 2 amount"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="Item 1 name"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="Item 2 name"]')).not.toBeNull();
	});

	it('names each item Remove button by its row', () => {
		const { container } = renderForm({
			splitMode: 'itemized',
			items: [
				{ label: 'Pizza', amount: 0, splitMode: 'equal', beneficiaries: [] },
				{ label: 'Salad', amount: 0, splitMode: 'equal', beneficiaries: [] }
			]
		});
		expect(container.querySelector('[aria-label="Remove item 1"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="Remove item 2"]')).not.toBeNull();
	});

	it('names the per-member share input by the member (share split)', () => {
		const { container } = renderForm({
			splitMode: 'share',
			beneficiaries: [
				{ memberId: 'm-alex', shareWeight: 1 },
				{ memberId: 'm-bo', shareWeight: 1 }
			]
		});
		expect(container.querySelector('[aria-label="Shares for Alex"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="Shares for Bo"]')).not.toBeNull();
	});

	it('names the per-member amount input by the member (amount split)', () => {
		const { container } = renderForm({
			splitMode: 'amount',
			beneficiaries: [{ memberId: 'm-alex', rawAmount: 0 }]
		});
		expect(container.querySelector('[aria-label="Amount for Alex"]')).not.toBeNull();
	});

	it('gives the category and currency Select triggers accessible names', () => {
		const { container } = renderForm();
		expect(container.querySelector('[aria-label="Category"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="Currency"]')).not.toBeNull();
	});

	it('associates the title validation error with the input (aria-invalid + describedby)', async () => {
		const { form, container } = renderForm({ title: '' });
		// Force a client validation error on `title` so the errored UI renders.
		form.errors.set({ title: ['A title is required'] } as never);
		await new Promise((r) => setTimeout(r, 0));

		const input = container.querySelector('#title');
		expect(input).not.toBeNull();
		expect(input?.getAttribute('aria-invalid')).toBe('true');
		expect(input?.getAttribute('aria-describedby')).toBe('title-error');

		const message = container.querySelector('#title-error');
		expect(message).not.toBeNull();
		expect(message?.textContent).toContain('A title is required');
		// Sanity: the store actually holds the error we set.
		expect(get(form.errors).title).toEqual(['A title is required']);
	});
});
