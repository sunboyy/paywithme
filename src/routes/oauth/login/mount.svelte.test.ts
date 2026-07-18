import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { defaults } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { loginSchema } from '$lib/schemas/auth';

// Mock the browser auth client: passkey sign-in + the session check the resume
// decision hinges on.
const { signInPasskey, getSession } = vi.hoisted(() => ({
	signInPasskey: vi.fn(),
	getSession: vi.fn()
}));
vi.mock('$lib/auth-client', () => ({
	authClient: { signIn: { passkey: signInPasskey }, getSession }
}));

import Page from './+page.svelte';
import type { PageData } from './$types';

const RESUME_URL =
	'/api/auth/mcp/authorize?response_type=code&client_id=client_abc&scope=openid%20write';

function pageData(): PageData {
	return { form: defaults(zod4(loginSchema)), oauthResume: RESUME_URL } as unknown as PageData;
}

// Replace window.location so we can observe the full-page resume navigation
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

		// The magic-link fallback is a real POST form carrying the resume URL, so the
		// no-JS path also completes the authorization.
		const form = container.querySelector('form[method="POST"]');
		expect(form).not.toBeNull();
		const hidden = container.querySelector<HTMLInputElement>(
			'input[type="hidden"][name="redirectTo"]'
		);
		expect(hidden?.value).toBe(RESUME_URL);
	});

	it('passkey success → RESUMES the authorization with a full-page navigation to the authorize URL', async () => {
		signInPasskey.mockResolvedValue({ data: {}, error: null });
		getSession.mockResolvedValue({ data: { user: { id: 'u1' } } });

		const { getByRole } = render(Page, { props: { data: pageData() } });
		await fireEvent.click(getByRole('button', { name: /passkey/i }));

		await waitFor(() => expect(assignMock).toHaveBeenCalledWith(RESUME_URL));
	});

	it('resumes based on the REAL session even when the passkey call throws (swallowed resume redirect)', async () => {
		// The plugin's post-login hook can turn the passkey response into a swallowed
		// cross-origin redirect (a thrown fetch), yet the session was created.
		signInPasskey.mockRejectedValue(new TypeError('Failed to fetch'));
		getSession.mockResolvedValue({ data: { user: { id: 'u1' } } });

		const { getByRole } = render(Page, { props: { data: pageData() } });
		await fireEvent.click(getByRole('button', { name: /passkey/i }));

		await waitFor(() => expect(assignMock).toHaveBeenCalledWith(RESUME_URL));
	});

	it('no session after the passkey attempt → shows an error and does NOT navigate', async () => {
		signInPasskey.mockResolvedValue({ data: null, error: { message: 'nope' } });
		getSession.mockResolvedValue({ data: null });

		const { getByRole } = render(Page, { props: { data: pageData() } });
		await fireEvent.click(getByRole('button', { name: /passkey/i }));

		await waitFor(() => expect(getByRole('alert')).toBeTruthy());
		expect(assignMock).not.toHaveBeenCalled();
	});
});
