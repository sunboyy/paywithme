import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
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

function renderForm(overrides: Partial<TransactionInput> = {}, currencies?: FormCurrency[]) {
	let form!: SuperForm<TransactionInput>;
	const result = render(TransactionFormHarness, {
		props: {
			seeded: seededFor(overrides),
			members,
			categories,
			currency,
			currencies,
			onform: (f) => (form = f)
		}
	});
	return { form, ...result };
}

/** A second supported currency, so the FX picker has something to choose between. */
const MULTI_CURRENCY: FormCurrency[] = [
	currency,
	{ code: 'JPY', symbol: '¥', exponent: 0, name: 'Japanese Yen' }
];

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

	it('gives the category Select trigger an accessible name', () => {
		const { container } = renderForm();
		expect(container.querySelector('[aria-label="Category"]')).not.toBeNull();
	});

	it('gives the currency Select trigger an accessible name when there is a choice', () => {
		const { container } = renderForm({}, MULTI_CURRENCY);
		expect(container.querySelector('[aria-label="Currency"]')).not.toBeNull();
	});

	it('OMITS the currency picker entirely when only one currency is supported', () => {
		// Nothing to choose between: the control would be a permanent full-width row
		// serving a decision the user cannot make.
		const { container } = renderForm();
		expect(container.querySelector('[aria-label="Currency"]')).toBeNull();
	});

	it('opens the currency disclosure already expanded for a FOREIGN entry currency', () => {
		// Otherwise the FX rate entry below it would sit behind an extra click on the
		// one path that actually needs it (an edit, or a §8.4 settle-up prefill).
		const { container } = renderForm({ currency: 'JPY' }, MULTI_CURRENCY);
		const disclosure = container.querySelector('details.group\\/currency');
		expect(disclosure).not.toBeNull();
		expect((disclosure as HTMLDetailsElement).open).toBe(true);
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

// ── The live "each person owes" preview (plan 005 item 3.4) ───────────────────
//
// This panel previously rendered ONLY for the itemized split, so equal / amount /
// share — the modes almost everyone uses — committed blind. These assert it now
// renders for every mode, and that it stays silent rather than guessing when the
// form isn't in a resolvable state.
describe('TransactionForm split preview', () => {
	it('shows a single "each" line for an equal split that divides cleanly', () => {
		// ฿90.00 between two members = ฿45.00 each, exactly.
		const { getByText } = renderForm({
			splitMode: 'equal',
			amountTotal: 9000,
			beneficiaries: [{ memberId: 'm-alex' }, { memberId: 'm-bo' }]
		});

		expect(getByText('Each person owes')).toBeTruthy();
		expect(getByText('฿45.00')).toBeTruthy();
	});

	it('lists PER MEMBER when an equal split leaves a remainder', () => {
		// ฿0.01 between two cannot be equal: one owes 0.01, the other 0.00. A single
		// "each" figure would be a lie, so the per-member list is used instead.
		const { container, queryByText } = renderForm({
			splitMode: 'equal',
			amountTotal: 1,
			beneficiaries: [{ memberId: 'm-alex' }, { memberId: 'm-bo' }]
		});

		expect(queryByText('Each person owes')).toBeTruthy();
		expect(container.textContent).toContain('Alex');
		expect(container.textContent).toContain('Bo');
	});

	it('previews an AMOUNT split from the entered per-member amounts', () => {
		const { container } = renderForm({
			splitMode: 'amount',
			amountTotal: 9000,
			beneficiaries: [
				{ memberId: 'm-alex', rawAmount: 6000 },
				{ memberId: 'm-bo', rawAmount: 3000 }
			]
		});

		expect(container.textContent).toContain('฿60.00');
		expect(container.textContent).toContain('฿30.00');
	});

	it("previews a SHARE split weighted by each member's weight", () => {
		// 2:1 over ฿90.00 → ฿60.00 / ฿30.00.
		const { container } = renderForm({
			splitMode: 'share',
			amountTotal: 9000,
			beneficiaries: [
				{ memberId: 'm-alex', shareWeight: 2 },
				{ memberId: 'm-bo', shareWeight: 1 }
			]
		});

		expect(container.textContent).toContain('฿60.00');
		expect(container.textContent).toContain('฿30.00');
	});

	it('shows NOTHING when no amount has been entered yet', () => {
		// A half-filled form must show no preview rather than a wrong one.
		const { queryByText } = renderForm({
			splitMode: 'equal',
			amountTotal: 0,
			beneficiaries: [{ memberId: 'm-alex' }, { memberId: 'm-bo' }]
		});

		expect(queryByText('Each person owes')).toBeNull();
	});

	it('shows NOTHING when nobody is selected to split between', () => {
		const { queryByText } = renderForm({
			splitMode: 'equal',
			amountTotal: 9000,
			beneficiaries: []
		});

		expect(queryByText('Each person owes')).toBeNull();
	});
});

// ── Per-payer amount entry (multiple payers) ─────────────────────────────────
//
// These inputs are typed into digit by digit, so what they render must be the
// user's raw string — NOT `formatAmount(amountPaid)`, which re-formatted on every
// keystroke and turned the first "5" into "5.00" under the caret.
describe('TransactionForm per-payer amounts', () => {
	const twoPayers = {
		payers: [
			{ memberId: 'm-alex', amountPaid: 0 },
			{ memberId: 'm-bo', amountPaid: 0 }
		]
	} satisfies Partial<TransactionInput>;

	/** The payer amount input for `name`, which only renders with >1 payer. */
	function paidInput(container: HTMLElement, name: string) {
		return container.querySelector<HTMLInputElement>(`[aria-label="Amount paid by ${name}"]`);
	}

	it('keeps the raw keystrokes instead of re-formatting mid-typing', async () => {
		const { container, form } = renderForm(twoPayers);
		const input = paidInput(container, 'Alex');
		expect(input).not.toBeNull();

		await fireEvent.input(input!, { target: { value: '5' } });
		expect(input!.value).toBe('5');

		// ...and the next digit extends it rather than landing after an injected ".00".
		await fireEvent.input(input!, { target: { value: '50' } });
		expect(input!.value).toBe('50');

		// The parsed minor units still track what was typed (฿50.00 = 5000).
		expect(get(form.form).payers).toContainEqual({ memberId: 'm-alex', amountPaid: 5000 });
	});

	it('keeps a trailing decimal point while it is being typed', async () => {
		const { container } = renderForm(twoPayers);
		const input = paidInput(container, 'Bo')!;

		await fireEvent.input(input, { target: { value: '12' } });
		await fireEvent.input(input, { target: { value: '12.' } });
		expect(input.value).toBe('12.');
	});

	it('refuses characters that are not part of an amount', async () => {
		const { container, form } = renderForm(twoPayers);
		const input = paidInput(container, 'Alex')!;

		await fireEvent.input(input, { target: { value: '12a' } });
		expect(input.value).toBe('12');
		// The refused keystroke must not survive in the DOM either: the cleaned string
		// equals the last rendered one, so nothing but a direct write clears it.
		expect(get(form.form).payers).toContainEqual({ memberId: 'm-alex', amountPaid: 1200 });
	});

	it('refuses a decimal place the currency does not have', async () => {
		// ฿ has 2. Typing a third digit must not land — the old behaviour left "12.345"
		// on screen while parseAmount rejected it, recording 0 paid.
		const { container, form } = renderForm(twoPayers);
		const input = paidInput(container, 'Alex')!;

		await fireEvent.input(input, { target: { value: '12.34' } });
		await fireEvent.input(input, { target: { value: '12.345' } });

		expect(input.value).toBe('12.34');
		expect(get(form.form).payers).toContainEqual({ memberId: 'm-alex', amountPaid: 1234 });
	});

	it('takes the exponent from the ENTRY currency, not the settlement one', async () => {
		// Entry in JPY (0 dp) while the group settles in THB: no decimals at all.
		const { container } = renderForm({ ...twoPayers, currency: 'JPY' }, MULTI_CURRENCY);
		const input = paidInput(container, 'Alex')!;

		await fireEvent.input(input, { target: { value: '1200.5' } });
		expect(input.value).toBe('1200');
	});

	it('seeds each input from an existing multi-payer transaction', () => {
		const { container } = renderForm({
			amountTotal: 9000,
			payers: [
				{ memberId: 'm-alex', amountPaid: 6000 },
				{ memberId: 'm-bo', amountPaid: 3000 }
			]
		});

		expect(paidInput(container, 'Alex')?.value).toBe('60.00');
		expect(paidInput(container, 'Bo')?.value).toBe('30.00');
	});

	it('shows the mirrored total once a second payer is added', async () => {
		// A single payer covers the whole total implicitly (no input rendered). When a
		// second payer joins, the first one's box must open ALREADY holding that total
		// rather than blank — otherwise Σ paid silently stops matching the total.
		const { container } = renderForm({
			amountTotal: 9000,
			payers: [{ memberId: 'm-alex', amountPaid: 9000 }]
		});
		expect(paidInput(container, 'Alex')).toBeNull();

		const paidBy = [...container.querySelectorAll('fieldset')].find(
			(f) => f.querySelector('legend')?.textContent === 'Paid by'
		)!;
		const boCheckbox = [...paidBy.querySelectorAll('[role="checkbox"]')][1];
		await fireEvent.click(boCheckbox);

		expect(paidInput(container, 'Alex')?.value).toBe('90.00');
		expect(paidInput(container, 'Bo')?.value).toBe('');
	});
});

// ── Every OTHER money field on the form ──────────────────────────────────────
//
// The per-payer boxes were the reported case, but the total, the per-member and
// per-item amounts, the FX settlement total and an absolute charge all take a raw
// typed string the same way. Each one used to accept a keystroke `parseAmount`
// refuses — leaving "12.345" on screen for an amount stored as 0.
describe('TransactionForm money-field entry', () => {
	function byLabel(container: HTMLElement, label: string) {
		return container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
	}

	it('constrains the AMOUNT total', async () => {
		const { container, form } = renderForm({ splitMode: 'equal' });
		const input = container.querySelector<HTMLInputElement>('#amountTotal')!;

		await fireEvent.input(input, { target: { value: '12.34' } });
		await fireEvent.input(input, { target: { value: '12.345' } });
		expect(input.value).toBe('12.34');

		await fireEvent.input(input, { target: { value: '12.34x' } });
		expect(input.value).toBe('12.34');
		expect(get(form.form).amountTotal).toBe(1234);
	});

	it('constrains a per-member AMOUNT-split box', async () => {
		const { container, form } = renderForm({
			splitMode: 'amount',
			amountTotal: 1234,
			beneficiaries: [{ memberId: 'm-alex', rawAmount: 0 }]
		});
		const input = byLabel(container, 'Amount for Alex');

		await fireEvent.input(input, { target: { value: '12.34' } });
		await fireEvent.input(input, { target: { value: '12.345' } });

		expect(input.value).toBe('12.34');
		expect(get(form.form).beneficiaries).toContainEqual({ memberId: 'm-alex', rawAmount: 1234 });
	});

	it('constrains an ITEM amount, which the derived total is summed from', async () => {
		// The worst case of the set: a refused item amount used to parse to 0 and drop
		// out of the itemized total silently, with no error anywhere on the form.
		const { container, form } = renderForm({
			splitMode: 'itemized',
			items: [{ label: 'Pizza', amount: 0, splitMode: 'equal', beneficiaries: [] }]
		});
		const input = byLabel(container, 'Item 1 amount');

		await fireEvent.input(input, { target: { value: '12.34' } });
		await fireEvent.input(input, { target: { value: '12.345' } });

		expect(input.value).toBe('12.34');
		expect(get(form.form).items[0].amount).toBe(1234);
	});

	it('constrains a per-member amount INSIDE an item', async () => {
		const { container, form } = renderForm({
			splitMode: 'itemized',
			items: [
				{
					label: 'Pizza',
					amount: 1234,
					splitMode: 'amount',
					beneficiaries: [{ memberId: 'm-alex', rawAmount: 0 }]
				}
			]
		});
		const input = byLabel(container, 'Item 1 amount for Alex');

		await fireEvent.input(input, { target: { value: '12.345' } });
		expect(input.value).toBe('12.34');
		expect(get(form.form).items[0].beneficiaries).toContainEqual({
			memberId: 'm-alex',
			rawAmount: 1234
		});
	});

	it('constrains an ABSOLUTE charge but leaves a PERCENT alone', async () => {
		const { container, form } = renderForm({
			splitMode: 'itemized',
			items: [{ label: 'Pizza', amount: 1000, splitMode: 'equal', beneficiaries: [] }],
			charges: [
				{ kind: 'service', mode: 'absolute', value: 0, base: 'items_subtotal', sortOrder: 0 },
				{ kind: 'vat', mode: 'percent', value: 0, base: 'items_subtotal', sortOrder: 1 }
			]
		});

		const absolute = byLabel(container, 'Charge 1 value');
		await fireEvent.input(absolute, { target: { value: '5.678' } });
		expect(absolute.value).toBe('5.67');
		expect(get(form.form).charges[0].value).toBe(567);

		// A percent is a different grammar (0–100 → basis points) and is deliberately
		// NOT run through the money sanitizer — 7.5% must keep its tenth of a percent.
		const percent = byLabel(container, 'Charge 2 value');
		await fireEvent.input(percent, { target: { value: '7.5' } });
		expect(percent.value).toBe('7.5');
		expect(get(form.form).charges[1].value).toBe(750);
	});

	it('constrains the FX settlement total by the SETTLEMENT currency', async () => {
		// Entry in JPY, settling in THB: this box is THB (2 dp) even though the amount
		// box beside it is JPY (0 dp).
		const { container } = renderForm({ currency: 'JPY' }, MULTI_CURRENCY);
		const input = container.querySelector<HTMLInputElement>('#fx-total')!;

		await fireEvent.input(input, { target: { value: '970.12' } });
		expect(input.value).toBe('970.12');

		await fireEvent.input(input, { target: { value: '970.123' } });
		expect(input.value).toBe('970.12');
	});
});
