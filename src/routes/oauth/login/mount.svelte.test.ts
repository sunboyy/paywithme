import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { defaults } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { loginSchema } from '$lib/schemas/auth';

// Mock the browser auth client's passkey sign-in. The page never checks the
// session itself: the server `load` decides whether to resume.
const { signInPasskey, getSession } = vi.hoisted(() => ({
	signInPasskey: vi.fn(),
	getSession: vi.fn()
}));
vi.mock('$lib/auth-client', () => ({
	authClient: { signIn: { passkey: signInPasskey }, getSession }
}));

import Page from './+page.svelte';
import type { PageData } from './$types';

/** This page's own URL, with the signed OAuth request. */
const CONTINUE_TO =
	'/oauth/login?response_type=code&client_id=client_abc&scope=openid%20write&prompt=login&sig=abc';

function pageData(): PageData {
	return { form: defaults(zod4(loginSchema)), continueTo: CONTINUE_TO } as unknown as PageData;
}

// Replace window.location so we can observe the full-page reload
// without jsdom attempting a real (unimplemented) navigation.
let assignMock: ReturnType<typeof vi.fn>;
const realLocation = window.location;

beforeEach(() => {
	signInPasskey.mockReset();
	getSession.mockReset();
	assignMock = vi.fn();
	Object.defineProperty(window, 'location', {
		configurable: true,
		value: { ...realLocation, assign: assignMock }
	});
});

afterEach(() => {
	Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
	cleanup();
});

describe('/oauth/login page', () => {
	it('renders the connect context and both sign-in paths (passkey + magic-link form)', () => {
		const { getByRole, getByText, container } = render(Page, { props: { data: pageData() } });

		expect(getByRole('heading', { level: 1 }).textContent).toMatch(/connect/i);
		expect(getByText(/read-only, or full access/i)).toBeTruthy();
		expect(getByRole('button', { name: /passkey/i })).toBeTruthy();

		// The magic-link fallback is a real POST form that comes back to THIS page
		// (with the request), so the no-JS path also completes the authorization.
		const form = container.querySelector('form[method="POST"]');
		expect(form).not.toBeNull();
		const hidden = container.querySelector<HTMLInputElement>(
			'input[type="hidden"][name="redirectTo"]'
		);
		expect(hidden?.value).toBe(CONTINUE_TO);
	});

	it('passkey success → reloads this page, so the server decides whether to resume', async () => {
		signInPasskey.mockResolvedValue({ data: {}, error: null });

		const { getByRole } = render(Page, { props: { data: pageData() } });
		await fireEvent.click(getByRole('button', { name: /passkey/i }));

		await waitFor(() => expect(assignMock).toHaveBeenCalledWith(CONTINUE_TO));
		// Resuming never hinges on whatever session the browser already has.
		expect(getSession).not.toHaveBeenCalled();
	});

	it('a cancelled/failed passkey prompt shows an error and does NOT navigate, even with an existing session', async () => {
		// The old session is still valid (the `prompt=login` case). It must not be
		// used to resume.
		getSession.mockResolvedValue({ data: { user: { id: 'u1' } } });
		signInPasskey.mockResolvedValue({ data: null, error: { message: 'cancelled' } });

		const { getByRole } = render(Page, { props: { data: pageData() } });
		await fireEvent.click(getByRole('button', { name: /passkey/i }));

		await waitFor(() => expect(getByRole('alert')).toBeTruthy());
		expect(assignMock).not.toHaveBeenCalled();
	});

	it('a thrown passkey call is a failure too: error, no navigation', async () => {
		signInPasskey.mockRejectedValue(new TypeError('Failed to fetch'));

		const { getByRole } = render(Page, { props: { data: pageData() } });
		await fireEvent.click(getByRole('button', { name: /passkey/i }));

		await waitFor(() => expect(getByRole('alert')).toBeTruthy());
		expect(assignMock).not.toHaveBeenCalled();
	});
});
