import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import Page from './+page.svelte';
import type { PageData } from './$types';

// Client tests for the receiving-method editor screen (issue #85; PLAN §17.1–§17.2,
// §17.4, §10).
//
// What is asserted here is the part of the screen the server spec cannot see:
//   - the REORDER affordance is move-up / move-down (never drag-and-drop), and
//     each is a real `<form>` that posts the direction — so it works with JS off;
//   - "first is preferred" is SAID, not left to be inferred from list order
//     (PLAN §17.1);
//   - the empty state explains what the screen is for in one line (PLAN §17.4) —
//     a user who has never settled up has no context for it;
//   - the add step is a plain link per rail, walked from `data.rails`, so no rail
//     is named in the markup and no JS is needed to choose one.

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

afterEach(cleanup);

const RAILS: PageData['rails'] = [
	{
		id: 'th_bank_account',
		label: 'Thai bank account',
		fields: [
			{
				name: 'bank',
				label: 'Bank',
				control: 'select',
				options: [{ value: 'kbank', label: 'Kasikornbank (KBank)' }]
			},
			{ name: 'accountNumber', label: 'Account number', control: 'text' },
			{ name: 'accountHolderName', label: 'Account holder name', control: 'text' }
		]
	},
	{ id: 'other', label: 'Other', fields: [{ name: 'label', label: 'Label', control: 'text' }] }
];

const METHODS: PageData['methods'] = [
	{
		id: 'rm1',
		railLabel: 'Thai bank account',
		summary: 'Kasikornbank (KBank) · 1234567890 · Somchai Jaidee',
		isFirst: true,
		isLast: false
	},
	{
		id: 'rm2',
		railLabel: 'PromptPay',
		summary: 'Mobile number · 0812345678 · Somchai Jaidee',
		isFirst: false,
		isLast: true
	}
];

function pageData(overrides: Partial<PageData> = {}): PageData {
	return { methods: METHODS, rails: RAILS, editing: null, ...overrides } as PageData;
}

function renderPage(data: PageData = pageData()) {
	return render(Page, { props: { data, form: null } });
}

describe('the profile list', () => {
	it('lists each method by its rail label and the rail’s own formatted line', () => {
		const { container } = renderPage();

		const rows = container.querySelectorAll('[data-testid="receiving-method-row"]');
		expect(rows).toHaveLength(2);
		expect(rows[0].textContent).toContain('Thai bank account');
		expect(rows[0].textContent).toContain('Kasikornbank (KBank) · 1234567890 · Somchai Jaidee');
	});

	it('says the first one is preferred, rather than leaving it to be inferred', () => {
		const { container } = renderPage();

		const rows = container.querySelectorAll('[data-testid="receiving-method-row"]');
		expect(rows[0].textContent).toContain('Preferred');
		expect(rows[1].textContent).not.toContain('Preferred');
	});

	it('keeps the row actions on one line when the holder name is long', () => {
		// An account holder name is a third-party string — a Thai name runs long and
		// unbroken. The text column wraps; the actions must not, or Remove drops onto
		// a line of its own and the row reads as broken.
		const { container } = renderPage(
			pageData({
				methods: [
					{
						id: 'rm1',
						railLabel: 'Thai bank account',
						summary: 'Siam Commercial Bank (SCB) · 1231231234 · ณัฐวรรธน์ ศุภกิจเจริญวงศ์ไพศาล',
						isFirst: true,
						isLast: true
					}
				]
			})
		);

		const actions = container.querySelector('[data-testid="receiving-method-actions"]');
		expect(actions?.className).toContain('shrink-0');

		// The squeeze has to land somewhere: the text column takes it.
		const summary = container.querySelector('[data-testid="receiving-method-row"] p.text-sm');
		expect(summary?.className).toContain('break-words');
	});

	it('reorders with real move-up / move-down forms, not drag-and-drop', () => {
		const { container } = renderPage();

		const moveForms = container.querySelectorAll('form[action="?/move"]');
		// One pair per row, each posting the id and the direction.
		expect(moveForms).toHaveLength(4);
		const directions = [...moveForms].map((form) =>
			form.querySelector('input[name="direction"]')?.getAttribute('value')
		);
		expect(directions).toEqual(['up', 'down', 'up', 'down']);
		expect(container.querySelector('[draggable="true"]')).toBeNull();
	});

	it('disables the move that would fall off the end of the list', () => {
		const { container } = renderPage();

		const buttons = [...container.querySelectorAll('form[action="?/move"] button')];
		// First row can't move up; last row can't move down.
		expect(buttons.map((button) => (button as HTMLButtonElement).disabled)).toEqual([
			true,
			false,
			false,
			true
		]);
	});

	it('offers edit and a real delete form per row', () => {
		const { container } = renderPage();

		expect(container.querySelector('a[href="/settings/receiving?edit=rm1"]')).not.toBeNull();
		expect(container.querySelectorAll('form[action="?/delete"]')).toHaveLength(2);
	});

	it('says a row is unreadable instead of showing half an account', () => {
		const { container } = renderPage(
			pageData({ methods: [{ ...METHODS[0], summary: null, isLast: true }] })
		);

		expect(container.textContent).toContain('These details can no longer be shown');
	});
});

describe('the empty state', () => {
	it('explains in one line what the screen is for', () => {
		const { getByTestId } = renderPage(pageData({ methods: [] }));

		const text = getByTestId('receiving-empty').textContent ?? '';
		expect(text).toContain('No receiving methods yet');
		expect(text.replace(/\s+/g, ' ')).toContain('settling up with you');
	});

	it('still offers every rail to add', () => {
		const { container } = renderPage(pageData({ methods: [] }));

		expect(
			container.querySelector('a[href="/settings/receiving?add=th_bank_account"]')
		).not.toBeNull();
		expect(container.querySelector('a[href="/settings/receiving?add=other"]')).not.toBeNull();
	});
});

describe('the add / edit step', () => {
	it('offers one link per registry rail — no rail is named in the markup', () => {
		const { container } = renderPage();

		for (const rail of RAILS) {
			const link = container.querySelector(`a[href="/settings/receiving?add=${rail.id}"]`);
			expect(link?.textContent?.trim(), rail.id).toBe(rail.label);
		}
	});

	it('renders the chosen rail’s own fields, and posts back to the same step', () => {
		const { container } = renderPage(
			pageData({
				editing: { methodId: null, rail: RAILS[0], values: { bank: '', accountNumber: '' } }
			})
		);

		const form = container.querySelector('form[method="POST"]') as HTMLFormElement;
		// The step's query param rides along, so a rejected submit re-renders this
		// form instead of bouncing back to the list.
		expect(form.getAttribute('action')).toBe('?/add&add=th_bank_account');
		expect(form.querySelector('input[name="rail"]')?.getAttribute('value')).toBe('th_bank_account');
		for (const field of RAILS[0].fields) {
			expect(form.querySelector(`[name="${field.name}"]`), field.name).not.toBeNull();
		}
	});

	it('edits through ?/edit with the row id, and never posts a rail', () => {
		const { container } = renderPage(
			pageData({
				editing: { methodId: 'rm1', rail: RAILS[0], values: { bank: 'kbank' } }
			})
		);

		const form = container.querySelector('form[method="POST"]') as HTMLFormElement;
		expect(form.getAttribute('action')).toBe('?/edit&edit=rm1');
		expect(form.querySelector('input[name="id"]')?.getAttribute('value')).toBe('rm1');
		// The rail is read from the stored row — a form may not move a method onto
		// another rail (#84).
		expect(form.querySelector('input[name="rail"]')).toBeNull();
	});

	it('shows the field errors the server returned, over the values the user typed', () => {
		// The messages are the RAIL SCHEMA'S, passed through by the action — the page
		// neither writes nor re-checks a validation rule.
		const { container, getByText } = render(Page, {
			props: {
				data: pageData({
					editing: { methodId: null, rail: RAILS[0], values: { accountNumber: '' } }
				}),
				form: {
					intent: 'add',
					values: { accountNumber: '12x' },
					fieldErrors: { accountNumber: ['Account number must contain digits only'] }
				}
			}
		});

		expect(getByText('Account number must contain digits only')).toBeTruthy();
		// Re-rendered with what was typed, not blanked back to the stored value.
		expect((container.querySelector('[name="accountNumber"]') as HTMLInputElement).value).toBe(
			'12x'
		);
	});
});
