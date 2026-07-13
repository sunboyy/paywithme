import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { defaults } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { createApiKeySchema } from '$lib/schemas/api-key';
import Page from './+page.svelte';
import type { PageData } from './$types';

// Rendered-markup tests for the create-key page (PLAN §16.8).
//
// These assert the "works with JS disabled" contract at the only level where it is
// actually observable: the HTML. A JS-disabled browser can only submit what the
// SERVER sent, so the page must ship a real POST <form> containing real, NAMED
// form controls — not JS-driven widgets. (A `RadioGroup` component would render
// <button>s and submit nothing; these tests are what would catch that swap.)

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

function pageData(): PageData {
	return {
		user: { name: 'Alex', email: 'alex@example.com' },
		form: defaults(zod4(createApiKeySchema))
	} as unknown as PageData;
}

afterEach(cleanup);

describe('/settings/api-keys/new page', () => {
	it('renders a real POST form (the no-JS submit path)', () => {
		const { container } = render(Page, { props: { data: pageData() } });

		const form = container.querySelector('form');
		expect(form).not.toBeNull();
		expect(form?.getAttribute('method')?.toLowerCase()).toBe('post');
	});

	it('renders NATIVE radio inputs for both scopes, named `scope`', () => {
		const { container } = render(Page, { props: { data: pageData() } });

		const radios = Array.from(
			container.querySelectorAll<HTMLInputElement>('input[type="radio"][name="scope"]')
		);
		expect(radios.map((r) => r.value).sort()).toEqual(['read', 'write']);
		// Least privilege is pre-selected in the SSR'd HTML, so a no-JS submit that
		// touches nothing yields a key that cannot move money (§16.2).
		expect(radios.find((r) => r.value === 'read')?.checked).toBe(true);
	});

	it('explains the money-safety difference between the scopes inline (§16.2)', () => {
		const { getByText } = render(Page, { props: { data: pageData() } });

		expect(getByText(/never move money/i)).toBeTruthy();
		expect(getByText(/can move money on your behalf/i)).toBeTruthy();
	});

	it('renders Never (default) + 30/90/365 + custom as native expiry radios', () => {
		const { container } = render(Page, { props: { data: pageData() } });

		const radios = Array.from(
			container.querySelectorAll<HTMLInputElement>('input[type="radio"][name="expiry"]')
		);
		expect(radios.map((r) => r.value)).toEqual(['never', '30', '90', '365', 'custom']);
		expect(radios.find((r) => r.value === 'never')?.checked).toBe(true);
	});

	it('ALWAYS renders the custom-days input (a no-JS page cannot reveal it later)', () => {
		const { container } = render(Page, { props: { data: pageData() } });

		// Even though "Never" is selected, the field must already be in the DOM —
		// otherwise a JS-disabled user could select "Custom" and have nowhere to type.
		const custom = container.querySelector<HTMLInputElement>('input[name="customDays"]');
		expect(custom).not.toBeNull();
		expect(custom?.type).toBe('number');
	});
});
