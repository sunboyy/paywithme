import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import Page from './+page.svelte';
import type { PageData } from './$types';

// Rendered-markup tests for the `/oauth/consent` screen (ADR-0010 §Decision(4), #41).
//
// These assert the SERVER-FIRST contract at the level it is observable — the HTML:
// a JS-disabled browser can only submit a real POST <form> with real, named
// controls, so the Allow/Deny decision must ride native submit buttons + a hidden
// `consent_code`. And the read-vs-write ("can it move money?") distinction must be
// spelled out, mirroring the api-key scope picker.

// `$app/forms` is a SvelteKit virtual module; stub it so `use:enhance` is a no-op
// action in jsdom (the enhancement is untestable here — only the no-JS HTML is).
vi.mock('$app/forms', () => ({
	enhance: () => ({ destroy() {} }),
	applyAction: vi.fn()
}));

function pageData(overrides: Partial<PageData> = {}): PageData {
	return {
		consentCode: 'c1',
		clientId: 'claude-connector',
		scopes: ['openid', 'read'],
		canMoveMoney: false,
		...overrides
	} as unknown as PageData;
}

afterEach(cleanup);

describe('/oauth/consent page', () => {
	it('renders a real POST form carrying the consent_code (the no-JS submit path)', () => {
		const { container } = render(Page, { props: { data: pageData(), form: null } });

		const form = container.querySelector('form');
		expect(form?.getAttribute('method')?.toLowerCase()).toBe('post');
		const hidden = container.querySelector<HTMLInputElement>('input[name="consent_code"]');
		expect(hidden?.value).toBe('c1');
	});

	it('offers Allow and Deny as native submit buttons wired to the two actions', () => {
		const { container } = render(Page, { props: { data: pageData(), form: null } });

		const formactions = Array.from(
			container.querySelectorAll<HTMLButtonElement>('button[type="submit"][formaction]')
		).map((b) => b.getAttribute('formaction'));
		expect(formactions).toContain('?/allow');
		expect(formactions).toContain('?/deny');
	});

	it('shows the READ-only money-safety copy for a read request', () => {
		const { getByText, queryByText } = render(Page, {
			props: { data: pageData({ canMoveMoney: false }), form: null }
		});

		expect(getByText(/can never move money/i)).toBeTruthy();
		expect(queryByText(/can move money on your behalf/i)).toBeNull();
	});

	it('makes the money-moving warning prominent for a WRITE request', () => {
		const { getByText } = render(Page, {
			props: {
				data: pageData({ scopes: ['openid', 'read', 'write'], canMoveMoney: true }),
				form: null
			}
		});

		// Same copy as the api-key picker — the two surfaces read as one product.
		expect(getByText(/can move money on your behalf/i)).toBeTruthy();
	});

	it('shows an expired-request state (and no Allow/Deny) when there is no consent code', () => {
		const { container, getByText } = render(Page, {
			props: { data: pageData({ consentCode: null }), form: null }
		});

		expect(getByText(/this request has expired/i)).toBeTruthy();
		expect(container.querySelector('button[type="submit"][formaction]')).toBeNull();
	});
});
