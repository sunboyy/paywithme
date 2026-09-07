import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import Page from './+page.svelte';
import type { PageData } from './$types';

// Screen tests for the quick-capture form (issue #50; PLAN §7.7, §10).
//
// The feature is judged on TAPS AND REQUIRED FIELDS, so that is what is asserted:
// exactly one required control, the other two already carrying a usable default,
// and every one of them a real form control inside ONE real form — so the screen
// posts with JavaScript disabled.
//
// The word "Capture" is internal vocabulary (§7.7 / CONTEXT.md) and must not reach
// the screen; the phrase is "not recorded yet".

vi.mock('$app/paths', () => ({
	resolve: (path: string, params?: Record<string, string>) =>
		params ? path.replace(/\[(\w+)\]/g, (_, k) => params[k] ?? `[${k}]`) : path
}));
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));

function pageData(): PageData {
	return {
		group: { id: 'g1', name: 'Trip', settlementCurrency: 'THB' },
		currencies: [
			{ code: 'THB', displayCode: 'THB', symbol: '฿', exponent: 2, name: 'Thai Baht' },
			{ code: 'JPY', displayCode: 'JPY', symbol: '¥', exponent: 0, name: 'Japanese Yen' },
			{ code: 'cur_beer', displayCode: 'BEER', symbol: '🍺', exponent: 0, name: 'Beer' }
		],
		values: { note: '', amount: '', currency: 'THB', capturedFor: '2026-09-07' },
		noteMaxLength: 200
	} as unknown as PageData;
}

afterEach(cleanup);

describe('quick-capture screen', () => {
	it('is ONE form with exactly one required field — the note', () => {
		const { container } = render(Page, { props: { data: pageData(), form: null } });

		const forms = container.querySelectorAll('form');
		expect(forms).toHaveLength(1);
		expect(forms[0].getAttribute('method')?.toUpperCase()).toBe('POST');

		const required = forms[0].querySelectorAll('[required]');
		expect(required).toHaveLength(1);
		expect(required[0].getAttribute('name')).toBe('note');
	});

	it('posts the three fields as real named controls (works with JS off)', () => {
		const { container } = render(Page, { props: { data: pageData(), form: null } });

		expect(container.querySelector('[name="note"]')).not.toBeNull();
		expect(container.querySelector('[name="amount"]')).not.toBeNull();
		expect(container.querySelector('[name="capturedFor"]')).not.toBeNull();
		// A native <select>, so the currency posts without hydration.
		expect(container.querySelector('select[name="currency"]')).not.toBeNull();
	});

	it("defaults the currency to the group's and the date to today", () => {
		const { container } = render(Page, { props: { data: pageData(), form: null } });

		const select = container.querySelector<HTMLSelectElement>('select[name="currency"]');
		expect(select?.value).toBe('THB');

		const date = container.querySelector<HTMLInputElement>('[name="capturedFor"]');
		expect(date?.getAttribute('type')).toBe('date');
		expect(date?.value).toBe('2026-09-07');
	});

	it('offers the group-scoped currencies by DISPLAY code, never the opaque key', () => {
		const { container } = render(Page, { props: { data: pageData(), form: null } });

		const select = container.querySelector('select[name="currency"]');
		expect(select?.textContent).toContain('BEER');
		expect(select?.textContent).not.toContain('cur_beer');
		// …but the opaque key is what gets POSTED (it is the stored code).
		const options = [...container.querySelectorAll('option')].map((o) => o.value);
		expect(options).toContain('cur_beer');
	});

	it('re-renders what was typed, with the message against its own field', () => {
		const { container } = render(Page, {
			props: {
				data: pageData(),
				form: {
					values: {
						note: 'dinner',
						amount: '12.345',
						currency: 'THB',
						capturedFor: '2026-09-01'
					},
					fieldErrors: { amount: ['Enter a valid amount'] }
				} as never
			}
		});

		const amount = container.querySelector<HTMLInputElement>('[name="amount"]');
		expect(amount?.value).toBe('12.345');
		expect(amount?.getAttribute('aria-invalid')).toBe('true');
		expect(container.querySelector('#amount-error')?.textContent).toContain('Enter a valid amount');
		// The note it rejected is still there — nothing typed is thrown away.
		expect(container.querySelector<HTMLTextAreaElement>('[name="note"]')?.value).toBe('dinner');
	});

	it('never says the internal word "capture" (§7.7 naming)', () => {
		const { container } = render(Page, { props: { data: pageData(), form: null } });
		expect(container.textContent?.toLowerCase()).not.toContain('capture');
	});
});
