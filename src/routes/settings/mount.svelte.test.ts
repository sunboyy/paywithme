import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { defaults } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { deletePasskeySchema } from '$lib/schemas/auth';
import { revokeApiKeySchema } from '$lib/schemas/api-key';
import type { ApiKeyListItem } from '$lib/server/api-keys';
import Page from './+page.svelte';
import type { PageData } from './$types';

// Rendered-markup tests for the API-keys section of `/settings` (PLAN §16.8).
//
// Covers the two acceptance criteria that are only visible in the DOM: the
// first-run empty state offering BOTH a create CTA and the API docs, and a key row
// showing every field (name, scope badge, `start` prefix, created, last-used,
// expiry) with a REAL revoke form — no collapsing on mobile, no JS-only controls.

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
// PARTIAL mock: superForm itself calls `beforeNavigate`/`afterNavigate`, so the
// real module must stay intact — we only stub the one function the page calls.
vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	invalidateAll: vi.fn()
}));
vi.mock('$lib/auth-client', () => ({ authClient: { passkey: { addPasskey: vi.fn() } } }));

const key: ApiKeyListItem = {
	id: 'key_1',
	name: 'My agent',
	scope: 'read',
	start: 'pwm_test_ab',
	createdAt: '2026-01-02T03:04:05.000Z',
	lastRequest: null,
	expiresAt: null,
	expired: false
};

function pageData(apiKeys: ApiKeyListItem[]): PageData {
	return {
		user: { name: 'Alex', email: 'alex@example.com' },
		passkeys: [],
		apiKeys,
		deleteForm: defaults(zod4(deletePasskeySchema)),
		revokeApiKeyForm: defaults(zod4(revokeApiKeySchema))
	} as unknown as PageData;
}

afterEach(cleanup);

describe('/settings — API keys section', () => {
	it('offers BOTH Create key and View API docs when there are no keys', () => {
		const { getByText } = render(Page, { props: { data: pageData([]) } });

		// Two equal-weight buttons, both real links (PLAN §16.8 empty/first-run).
		const create = getByText('Create key').closest('a');
		expect(create?.getAttribute('href')).toBe('/settings/api-keys/new');
		const docs = getByText('View API docs').closest('a');
		expect(docs?.getAttribute('href')).toBe('/docs/api');
	});

	it('shows every field for a key, and a REAL revoke form (works without JS)', () => {
		const { getByTestId, getByText } = render(Page, {
			props: {
				data: pageData([{ ...key, lastRequest: '2026-03-04T00:00:00.000Z' }])
			}
		});

		const row = getByTestId('api-key-row');
		expect(row.textContent).toContain('My agent');
		// The `start` prefix is safe to show and is how two keys are told apart.
		expect(row.textContent).toContain('pwm_test_ab');
		expect(row.textContent).toContain('Created');
		expect(row.textContent).toContain('Last used');
		expect(row.textContent).toContain('Never expires');
		// Scope badge.
		expect(getByText('Read only')).toBeTruthy();

		// Revoke posts a real form action with the key id — no JS required.
		const form = row.querySelector('form');
		expect(form?.getAttribute('action')).toBe('?/revokeApiKey');
		expect(form?.getAttribute('method')?.toLowerCase()).toBe('post');
		const hidden = form?.querySelector<HTMLInputElement>('input[name="id"]');
		expect(hidden?.value).toBe('key_1');
	});

	it('marks an expired key distinctly', () => {
		const { getByText } = render(Page, {
			props: {
				data: pageData([{ ...key, expiresAt: '2026-01-09T00:00:00.000Z', expired: true }])
			}
		});

		expect(getByText('Expired')).toBeTruthy();
	});
});
