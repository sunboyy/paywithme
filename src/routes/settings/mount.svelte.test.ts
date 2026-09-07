import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { defaults } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { deletePasskeySchema } from '$lib/schemas/auth';
import type { PasskeyListItem } from './+page.server';
import Page from './+page.svelte';
import type { PageData } from './$types';

// Rendered-markup tests for the ACCOUNT screen: the passkey list, its empty
// state, and the settings tabs that carry the user to the sibling screens.

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
// PARTIAL mock: superForm itself calls `beforeNavigate`/`afterNavigate`, so the
// real module must stay intact — we only stub the one function the page calls.
vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	invalidateAll: vi.fn()
}));
vi.mock('$lib/auth-client', () => ({ authClient: { passkey: { addPasskey: vi.fn() } } }));

const passkey: PasskeyListItem = {
	id: 'pk_1',
	name: 'My iPhone',
	deviceHint: 'iCloud Keychain',
	createdAt: '2026-01-02T03:04:05.000Z'
};

function pageData(passkeys: PasskeyListItem[]): PageData {
	return {
		user: { name: 'Alex', email: 'alex@example.com' },
		passkeys,
		deleteForm: defaults(zod4(deletePasskeySchema))
	} as unknown as PageData;
}

afterEach(cleanup);

describe('/settings — the account screen', () => {
	it('names the account the screen is about', () => {
		const { getByText } = render(Page, { props: { data: pageData([]) } });

		expect(getByText('Alex')).toBeTruthy();
		expect(getByText('alex@example.com')).toBeTruthy();
	});

	it('reaches the sibling settings screens through the shared tabs', () => {
		const { getByRole } = render(Page, { props: { data: pageData([]) } });

		const nav = getByRole('navigation', { name: 'Settings sections' });
		const hrefs = [...nav.querySelectorAll('a')].map((a) => a.getAttribute('href'));
		expect(hrefs).toEqual(['/settings', '/settings/receiving', '/settings/api-keys']);
		expect(nav.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe('Account');
	});

	it('nudges a user with no passkeys, without hiding the add CTA', () => {
		const { getByTestId, getByText } = render(Page, { props: { data: pageData([]) } });

		expect(getByTestId('passkeys-empty').textContent).toContain('No passkeys yet');
		expect(getByText('Add a passkey')).toBeTruthy();
	});

	it('lists a passkey with a REAL delete form (works without JS)', () => {
		const { getByRole } = render(Page, { props: { data: pageData([passkey]) } });

		const list = getByRole('list', { name: 'Your passkeys' });
		expect(list.textContent).toContain('My iPhone');
		expect(list.textContent).toContain('iCloud Keychain');

		const form = list.querySelector('form');
		expect(form?.getAttribute('action')).toBe('?/delete');
		expect(form?.getAttribute('method')?.toLowerCase()).toBe('post');
		expect(form?.querySelector<HTMLInputElement>('input[name="id"]')?.value).toBe('pk_1');
	});
});
