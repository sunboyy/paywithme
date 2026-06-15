import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

// Mock the auth instance so nothing touches a real DB/network. `listPasskeys`
// and `deletePasskey` are spies we drive per-test. `vi.hoisted` makes them
// available inside the hoisted `vi.mock` factory.
const { listPasskeys, deletePasskey } = vi.hoisted(() => ({
	listPasskeys: vi.fn(),
	deletePasskey: vi.fn()
}));
vi.mock('$lib/server/auth', () => ({
	auth: { api: { listPasskeys, deletePasskey } }
}));

import { load, actions } from './+page.server';
import type { PasskeyListItem } from './+page.server';

/** `load`'s success-branch shape (the redirect branch returns `void`). */
type LoadData = {
	passkeys: PasskeyListItem[];
	deleteForm: { id: string; data: { id: string } };
};

type User = { name: string };

/** Minimal `load` event with `locals.user` + a real `request` (headers used). */
function makeLoadEvent(user: User | null) {
	return {
		request: new Request('http://localhost/settings'),
		locals: { user, session: user ? {} : null }
	} as unknown as Parameters<typeof load>[0];
}

/** Build a SvelteKit-action `RequestEvent` with a form-encoded POST body. */
function makeActionEvent(fields: Record<string, string>) {
	const body = new URLSearchParams(fields);
	const request = new Request('http://localhost/settings', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: body.toString()
	});
	return { request } as unknown as Parameters<(typeof actions)['delete']>[0];
}

describe('/settings load', () => {
	beforeEach(() => {
		listPasskeys.mockReset();
		deletePasskey.mockReset();
	});

	it('redirects an anonymous user to /login and never lists passkeys', async () => {
		try {
			await load(makeLoadEvent(null));
			expect.unreachable('expected a redirect to be thrown');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/login');
			}
		}

		expect(listPasskeys).not.toHaveBeenCalled();
	});

	it('returns the mapped passkeys and a valid delete form for an authenticated user', async () => {
		const created = new Date('2026-01-02T03:04:05.000Z');
		listPasskeys.mockResolvedValueOnce([
			{ id: 'pk_1', name: 'My iPhone', aaguid: undefined, createdAt: created },
			{ id: 'pk_2', name: undefined, aaguid: undefined, createdAt: created }
		]);

		const result = (await load(makeLoadEvent({ name: 'Alice' }))) as LoadData;

		expect(listPasskeys).toHaveBeenCalledTimes(1);
		expect(result.passkeys).toEqual([
			{ id: 'pk_1', name: 'My iPhone', deviceHint: null, createdAt: created.toISOString() },
			{ id: 'pk_2', name: null, deviceHint: null, createdAt: created.toISOString() }
		]);
		// A seeded delete form is returned for the per-row forms (its `id` field is
		// filled in per row from the hidden input, so the seed itself is empty).
		expect(result.deleteForm.data).toEqual({ id: '' });
	});

	it('returns an empty list (no 500/redirect) when listPasskeys throws', async () => {
		listPasskeys.mockRejectedValueOnce(new Error('passkey list backend unavailable'));

		const result = (await load(makeLoadEvent({ name: 'Alice' }))) as LoadData;

		expect(result.passkeys).toEqual([]);
		expect(result.deleteForm.data).toEqual({ id: '' });
		expect(listPasskeys).toHaveBeenCalledTimes(1);
	});
});

describe('/settings ?/delete action', () => {
	beforeEach(() => {
		listPasskeys.mockReset();
		deletePasskey.mockReset();
		deletePasskey.mockResolvedValue(undefined);
	});

	it('deletes the passkey by id (forwarding cloned headers) and returns a success message', async () => {
		const result = await actions.delete(makeActionEvent({ id: 'pk_abc' }));

		expect(deletePasskey).toHaveBeenCalledTimes(1);
		const arg = deletePasskey.mock.calls[0][0];
		expect(arg.body).toEqual({ id: 'pk_abc' });
		expect(arg.headers).toBeInstanceOf(Headers);

		const message = (result as { form: { message?: { type: string; text: string } } }).form.message;
		expect(message?.type).toBe('success');
		expect(message?.text).toBe('Passkey removed');
	});

	it('returns a 400 fail and does NOT call deletePasskey on an empty id', async () => {
		const result = (await actions.delete(makeActionEvent({ id: '' }))) as {
			status: number;
			data: { form: { valid: boolean } };
		};

		expect(deletePasskey).not.toHaveBeenCalled();
		expect(result.status).toBe(400);
		expect(result.data.form.valid).toBe(false);
	});

	it('returns a 400 fail and does NOT call deletePasskey on a missing id', async () => {
		const result = (await actions.delete(makeActionEvent({}))) as {
			status: number;
			data: { form: { valid: boolean } };
		};

		expect(deletePasskey).not.toHaveBeenCalled();
		expect(result.status).toBe(400);
		expect(result.data.form.valid).toBe(false);
	});

	it('returns a generic 500 error (no leak) when deletePasskey throws', async () => {
		deletePasskey.mockRejectedValueOnce(new Error('DB exploded: passkey row pk_secret'));

		const result = (await actions.delete(makeActionEvent({ id: 'pk_abc' }))) as {
			status: number;
			data: { form: { message?: { type: string; text: string } } };
		};

		expect(result.status).toBe(500);
		const message = result.data.form.message;
		expect(message?.type).toBe('error');
		// The raw cause must never reach the user (PLAN §12).
		expect(message?.text).not.toContain('DB exploded');
		expect(message?.text).not.toContain('pk_secret');
	});
});
