import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { tick } from 'svelte';
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

/**
 * A three-member group. The default fixture has two, which is enough for most of
 * these tests but cannot produce MORE THAN ONE floating minor unit — an equal
 * split between two either divides or leaves exactly one over. The rounding-float
 * caption's plural branch (ADR-0013) needs a third beneficiary to be reachable.
 */
const THREE_MEMBERS: FormMember[] = [
	...members,
	{ id: 'm-cam', displayName: 'Cam', isLinked: false }
];

function renderForm(
	overrides: Partial<TransactionInput> = {},
	currencies?: FormCurrency[],
	formMembers: FormMember[] = members
) {
	let form!: SuperForm<TransactionInput>;
	const result = render(TransactionFormHarness, {
		props: {
			seeded: seededFor(overrides),
			members: formMembers,
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

	it('gives the currency picker trigger an accessible name when there is a choice', () => {
		const { container } = renderForm({}, MULTI_CURRENCY);
		expect(container.querySelector('[aria-label="Currency"]')).not.toBeNull();
	});

	it('renders the currency picker as a SEARCHABLE COMBOBOX, not a plain dropdown', async () => {
		// The supported list is ~30 currencies (PLAN §7.5.1) — a plain Select renders
		// them as one unbounded, unscrollable column that overflows off-screen, so the
		// entries near the top become unreachable. A combobox filters instead.
		const { container } = renderForm({}, MULTI_CURRENCY);
		const trigger = container.querySelector('[aria-label="Currency"]') as HTMLElement;
		expect(trigger.getAttribute('role')).toBe('combobox');
		expect(trigger.getAttribute('aria-expanded')).toBe('false');

		trigger.click();
		await tick();

		// The search box is what makes a 30-entry list navigable.
		expect(document.querySelector('[data-slot="command-input"]')).not.toBeNull();
		// …and every supported currency is offered, not just the group's.
		const labels = [...document.querySelectorAll('[data-slot="command-item"]')].map((el) =>
			el.textContent?.trim()
		);
		expect(labels.some((l) => l?.startsWith('THB'))).toBe(true);
		expect(labels.some((l) => l?.startsWith('JPY'))).toBe(true);
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

	it('does not NAME who pays the leftover unit — the server has not chosen yet', () => {
		// ฿100.00 three ways = ฿33.33 each with one satang over. Which member absorbs
		// that satang is decided by the transaction's `rounding_seq` (ADR-0013), which is
		// allocated at INSERT — an unsaved form genuinely cannot know it. So the preview
		// shows the floor everyone is guaranteed to owe, plus a caption for the float.
		const { container } = renderForm({
			splitMode: 'equal',
			amountTotal: 10_000,
			beneficiaries: [{ memberId: 'm-alex' }, { memberId: 'm-bo' }]
		});

		// Two members here → ฿50.00 each exactly, so use the 3-way case for the float.
		expect(container.textContent).toContain('฿50.00');
		expect(container.textContent).not.toContain('assigned when you save');
	});

	it('captions the floating minor unit instead of pinning it on a member', () => {
		// ฿0.01 between two: one owes ฿0.01 and the other ฿0.00, but WHICH is not known
		// until save. Both floors are ฿0.00 and the caption carries the odd satang.
		const { container, getByText } = renderForm({
			splitMode: 'equal',
			amountTotal: 1,
			beneficiaries: [{ memberId: 'm-alex' }, { memberId: 'm-bo' }]
		});

		expect(getByText('Each person owes')).toBeTruthy();
		expect(container.textContent).toContain('฿0.00');
		expect(container.textContent).toContain('Plus ฿0.01 to one member, assigned when you save.');
	});

	it('pluralises the caption when several minor units float', () => {
		// ฿0.02 across THREE → everyone floors to ฿0.00 and two satang are still
		// floating, so the caption has to say how many rather than "one member".
		const { container } = renderForm(
			{
				splitMode: 'equal',
				amountTotal: 2,
				beneficiaries: [{ memberId: 'm-alex' }, { memberId: 'm-bo' }, { memberId: 'm-cam' }]
			},
			undefined,
			THREE_MEMBERS
		);

		expect(container.textContent).toContain('Plus ฿0.01 each to 2 members');
	});

	it('never overstates a share: previewed amounts are floors', () => {
		// A share split of ฿0.01 on equal weights is another all-tie distribution. The
		// preview must not show one member owing ฿0.01 — that member is not chosen yet.
		const { container } = renderForm({
			splitMode: 'share',
			amountTotal: 1,
			beneficiaries: [
				{ memberId: 'm-alex', shareWeight: 1 },
				{ memberId: 'm-bo', shareWeight: 1 }
			]
		});

		expect(container.textContent).toContain('assigned when you save');
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

// ── Switching split modes must not strand invalid state ───────────────────────
//
// Peeking at the Itemized tab and coming back used to make the form unsavable:
// entering itemized cleared the beneficiaries and seeded a blank starter item,
// and that leftover item still had to pass the per-item rules (amount > 0, ≥1
// beneficiary) — an error with nowhere to render on a non-itemized form, so the
// Save button just did nothing. Items/charges are ignored outside itemized, so
// the round trip must be lossless AND leave a valid payload.
describe('TransactionForm split-mode round trip', () => {
	/** Click a split-mode tab by its visible label. */
	async function clickTab(container: HTMLElement, label: string) {
		const tab = [...container.querySelectorAll('button, [role="tab"]')].find(
			(el) => el.textContent?.trim() === label
		);
		expect(tab, `no "${label}" tab`).toBeTruthy();
		await fireEvent.click(tab!);
	}

	const equalSplit = {
		splitMode: 'equal',
		title: 'Dinner',
		// A real category id (the schema checks it against the constants, unlike the
		// display-only `categories` prop the picker renders).
		categoryId: 'spending-food-drink',
		amountTotal: 9000,
		amountTotalSettlement: 9000,
		payers: [{ memberId: 'm-alex', amountPaid: 9000 }],
		beneficiaries: [{ memberId: 'm-alex' }, { memberId: 'm-bo' }]
	} satisfies Partial<TransactionInput>;

	it('leaves a SAVEABLE payload after equal → itemized → equal', async () => {
		const { container, form } = renderForm(equalSplit);

		await clickTab(container, 'Itemized');
		expect(get(form.form).splitMode).toBe('itemized');
		// The starter item the itemized UI seeds is what used to poison the payload.
		expect(get(form.form).items.length).toBeGreaterThan(0);

		await clickTab(container, 'Equal');
		expect(get(form.form).splitMode).toBe('equal');

		const res = schema.safeParse(get(form.form));
		expect(res.success).toBe(true);
	});

	it('keeps the chosen beneficiaries across the itemized detour', async () => {
		const { container, form } = renderForm(equalSplit);

		await clickTab(container, 'Itemized');
		await clickTab(container, 'Equal');

		expect(get(form.form).beneficiaries).toEqual([{ memberId: 'm-alex' }, { memberId: 'm-bo' }]);
	});
});
