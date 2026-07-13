import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import Page from './+page.svelte';
import type { PageData } from './$types';

// Rendered-markup tests for the one-time reveal screen (PLAN §16.8).
//
// The reveal must be usable WITHOUT JavaScript, so the show/hide affordance is a
// native <details> disclosure and the secret is real text inside it — a
// JS-only "reveal" would leave a no-JS user unable to ever read their key.

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

const SECRET = 'pwm_test_abcdefghijklmnopqrstuvwxyz';

function pageData(overrides: Partial<PageData> = {}): PageData {
	return {
		user: { name: 'Alex', email: 'alex@example.com' },
		key: SECRET,
		masked: 'pwm_test_abc••••••••',
		name: 'My agent',
		scope: 'write',
		expiresAt: null,
		...overrides
	} as unknown as PageData;
}

afterEach(cleanup);

describe('/settings/api-keys/created page', () => {
	it('warns — in plain words — that the key is shown only once', () => {
		const { getByText } = render(Page, { props: { data: pageData() } });

		expect(getByText(/only time the key is shown/i)).toBeTruthy();
		expect(getByText(/you won't see it again/i)).toBeTruthy();
	});

	it('shows the masked value by default and the secret behind a native <details>', () => {
		const { container, getByTestId } = render(Page, { props: { data: pageData() } });

		// Masked banner = the default state (server-rendered, no JS involved).
		expect(getByTestId('api-key-masked').textContent?.trim()).toBe('pwm_test_abc••••••••');

		// The full secret lives inside a <details> — toggleable with zero JS.
		const details = container.querySelector('details');
		expect(details).not.toBeNull();
		expect(details?.querySelector('[data-testid="api-key-secret"]')?.textContent).toBe(SECRET);
	});

	it('renders the scope badge and a never-expires key’s expiry line', () => {
		const { getByText } = render(Page, { props: { data: pageData() } });

		expect(getByText('Read & write')).toBeTruthy();
		expect(getByText('Never expires')).toBeTruthy();
	});
});
