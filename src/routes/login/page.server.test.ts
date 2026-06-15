import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the auth instance so the action never touches a real DB/network/email.
// `signInMagicLink` is a spy we assert against. `vi.hoisted` makes the spy
// available inside the hoisted `vi.mock` factory.
const { signInMagicLink } = vi.hoisted(() => ({ signInMagicLink: vi.fn() }));
vi.mock('$lib/server/auth', () => ({
	auth: { api: { signInMagicLink } }
}));

import { actions } from './+page.server';

/** Build a SvelteKit-action-style `RequestEvent` with a form-encoded POST body. */
function makeEvent(fields: Record<string, string>) {
	const body = new URLSearchParams(fields);
	const request = new Request('http://localhost/login', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: body.toString()
	});
	// Only the fields the action reads are provided.
	return { request } as unknown as Parameters<(typeof actions)['default']>[0];
}

describe('/login default action', () => {
	beforeEach(() => {
		signInMagicLink.mockReset();
		signInMagicLink.mockResolvedValue({ status: true });
	});

	it('sends the magic link with the normalized email, the 2.6 callbackURL, and NO name', async () => {
		const result = await actions.default(makeEvent({ email: '  ALICE@Example.COM ' }));

		expect(signInMagicLink).toHaveBeenCalledTimes(1);
		const arg = signInMagicLink.mock.calls[0][0];
		// Login does NOT collect a display name — the body must be email-only.
		expect(arg.body).toEqual({
			email: 'alice@example.com',
			callbackURL: '/auth/magic-link'
		});
		expect(arg.body).not.toHaveProperty('name');
		expect(arg.headers).toBeInstanceOf(Headers);

		// Success surfaces the `sent` message (same UX regardless of existence).
		expect((result as { form: { message?: { type: string } } }).form.message?.type).toBe('sent');
	});

	it('ignores a stray name field in the POST body (login is email-only)', async () => {
		// Even if a name is posted, the login schema strips it and the API call
		// must stay email-only.
		await actions.default(makeEvent({ email: 'a@b.com', name: 'Sneaky' }));

		expect(signInMagicLink).toHaveBeenCalledTimes(1);
		expect(signInMagicLink.mock.calls[0][0].body).not.toHaveProperty('name');
	});

	it('returns a 400 fail and does NOT call the auth API on invalid input', async () => {
		const result = (await actions.default(makeEvent({ email: 'not-an-email' }))) as {
			status: number;
			data: { form: { valid: boolean } };
		};

		expect(signInMagicLink).not.toHaveBeenCalled();
		expect(result.status).toBe(400);
		expect(result.data.form.valid).toBe(false);
	});

	it('returns a generic error (no leak) when the magic-link send fails', async () => {
		signInMagicLink.mockRejectedValueOnce(new Error('SMTP exploded: user did not exist'));

		// `message(form, ..., { status: 500 })` returns an ActionFailure shape
		// (`{ status, data: { form } }`), like `fail`.
		const result = (await actions.default(makeEvent({ email: 'a@b.com' }))) as {
			status: number;
			data: { form: { message?: { type: string; text: string } } };
		};

		expect(result.status).toBe(500);
		const message = result.data.form.message;
		expect(message?.type).toBe('error');
		// The raw cause must never reach the user (PLAN §12).
		expect(message?.text).not.toContain('SMTP');
		expect(message?.text).not.toContain('did not exist');
	});
});
