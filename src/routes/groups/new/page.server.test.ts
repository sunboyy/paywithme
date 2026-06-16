import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

// Mock the group service so the action never touches a real DB. `vi.hoisted`
// makes the spy available inside the hoisted `vi.mock` factory.
const { createGroup } = vi.hoisted(() => ({ createGroup: vi.fn() }));
vi.mock('$lib/server/groups', () => ({ createGroup }));

import { load, actions } from './+page.server';

type User = { id: string; name: string };

/** Minimal `load` event with `locals.user`. */
function makeLoadEvent(user: User | null) {
	return {
		locals: { user, session: user ? {} : null }
	} as unknown as Parameters<typeof load>[0];
}

/** Build a SvelteKit-action `RequestEvent` with a form-encoded POST body. */
function makeActionEvent(fields: Record<string, string>, user: User | null) {
	const body = new URLSearchParams(fields);
	const request = new Request('http://localhost/groups/new', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: body.toString()
	});
	return {
		request,
		locals: { user, session: user ? {} : null }
	} as unknown as Parameters<(typeof actions)['default']>[0];
}

describe('/groups/new load', () => {
	beforeEach(() => {
		createGroup.mockReset();
	});

	it('redirects an anonymous user to /login', async () => {
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
	});

	it('seeds a superforms form (empty name) for an authenticated user', async () => {
		const result = (await load(makeLoadEvent({ id: 'u1', name: 'Alice' }))) as {
			form: { data: { name: string; settlementCurrency: string } };
		};
		// superValidate seeds the enum field with its first member (no JS-less
		// "unselected" default exists for a z.enum), and the name field empty.
		expect(result.form.data.name).toBe('');
		expect(result.form.data.settlementCurrency).toBe('CNY');
	});
});

describe('/groups/new default action', () => {
	beforeEach(() => {
		createGroup.mockReset();
		createGroup.mockResolvedValue({ id: 'g1' });
	});

	it('redirects an anonymous POST to /login and never creates a group', async () => {
		try {
			await actions.default(makeActionEvent({ name: 'Trip', settlementCurrency: 'THB' }, null));
			expect.unreachable('expected a redirect to be thrown');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/login');
			}
		}
		expect(createGroup).not.toHaveBeenCalled();
	});

	it('returns a 400 fail and does NOT create a group on an empty name', async () => {
		const result = (await actions.default(
			makeActionEvent({ name: '', settlementCurrency: 'THB' }, { id: 'u1', name: 'Alice' })
		)) as { status: number; data: { form: { valid: boolean } } };

		expect(createGroup).not.toHaveBeenCalled();
		expect(result.status).toBe(400);
		expect(result.data.form.valid).toBe(false);
	});

	it('returns a 400 fail and does NOT create a group on an unsupported currency', async () => {
		const result = (await actions.default(
			makeActionEvent({ name: 'Trip', settlementCurrency: 'XXX' }, { id: 'u1', name: 'Alice' })
		)) as { status: number; data: { form: { valid: boolean } } };

		expect(createGroup).not.toHaveBeenCalled();
		expect(result.status).toBe(400);
		expect(result.data.form.valid).toBe(false);
	});

	it('creates the group with the right args and redirects to /groups on a valid POST', async () => {
		try {
			await actions.default(
				makeActionEvent(
					{ name: '  Trip to Chiang Mai  ', settlementCurrency: 'THB' },
					{ id: 'u1', name: 'Alice' }
				)
			);
			expect.unreachable('expected a redirect to be thrown');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/groups');
			}
		}

		expect(createGroup).toHaveBeenCalledTimes(1);
		expect(createGroup).toHaveBeenCalledWith({
			userId: 'u1',
			userName: 'Alice',
			// The schema trims the name before it reaches the service.
			name: 'Trip to Chiang Mai',
			settlementCurrency: 'THB'
		});
	});

	it('returns a generic 500 error (no leak) when createGroup throws', async () => {
		createGroup.mockRejectedValueOnce(new Error('DB exploded: group row g_secret'));

		const result = (await actions.default(
			makeActionEvent({ name: 'Trip', settlementCurrency: 'THB' }, { id: 'u1', name: 'Alice' })
		)) as { status: number; data: { form: { message?: { type: string; text: string } } } };

		expect(result.status).toBe(500);
		const message = result.data.form.message;
		expect(message?.type).toBe('error');
		expect(message?.text).not.toContain('DB exploded');
		expect(message?.text).not.toContain('g_secret');
	});
});
