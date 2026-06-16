import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

// Tests for the `/invite/[token]` accept-flow server logic (task 3.7; PLAN §6.2).
//
// STRATEGY (mirrors the other route tests): mock the invite SERVICE so nothing
// touches a real DB, then assert the route's CONTRACT — the `load` state machine
// (anonymous → need_auth w/ redirectTo; logged-in valid → ready; logged-in
// invalid → invalid) and the `accept` action (anonymous → redirect to /login
// w/ redirectTo; accepted/already_member → redirect to /groups/:id/members;
// invalid/slot_taken → the right fail state + message).

const { getInvitePreview, acceptInvite } = vi.hoisted(() => ({
	getInvitePreview: vi.fn(),
	acceptInvite: vi.fn()
}));
vi.mock('$lib/server/invites', () => ({ getInvitePreview, acceptInvite }));

import { load, actions } from './+page.server';

type User = { id: string; name: string };

/** Minimal `load` event with `params.token` + `locals.user`. */
function makeLoadEvent(token: string, user: User | null) {
	return {
		params: { token },
		locals: { user, session: user ? {} : null }
	} as unknown as Parameters<typeof load>[0];
}

/** Action-style event with `params.token` + `locals.user`. */
function makeActionEvent(token: string, user: User | null) {
	return {
		params: { token },
		locals: { user, session: user ? {} : null }
	} as unknown as Parameters<(typeof actions)['accept']>[0];
}

beforeEach(() => {
	getInvitePreview.mockReset();
	acceptInvite.mockReset();
});

describe('/invite/[token] load', () => {
	it('anonymous + valid token → need_auth with group name, valid flag, and redirectTo', async () => {
		getInvitePreview.mockResolvedValue({ status: 'valid', groupName: 'Trip to Tokyo' });

		const result = await load(makeLoadEvent('tok-abc', null));

		expect(result).toEqual({
			state: 'need_auth',
			groupName: 'Trip to Tokyo',
			valid: true,
			redirectTo: '/invite/tok-abc'
		});
	});

	it('anonymous + invalid token → need_auth with no group name and valid:false', async () => {
		getInvitePreview.mockResolvedValue({ status: 'invalid' });

		const result = await load(makeLoadEvent('dead', null));

		expect(result).toEqual({
			state: 'need_auth',
			groupName: null,
			valid: false,
			redirectTo: '/invite/dead'
		});
	});

	it('logged-in + valid token → ready with the group name (no auto-accept)', async () => {
		getInvitePreview.mockResolvedValue({ status: 'valid', groupName: 'Trip to Tokyo' });

		const result = await load(makeLoadEvent('tok-abc', { id: 'u1', name: 'Alice' }));

		expect(result).toEqual({ state: 'ready', groupName: 'Trip to Tokyo' });
		// load must NOT mutate.
		expect(acceptInvite).not.toHaveBeenCalled();
	});

	it('logged-in + invalid token → invalid', async () => {
		getInvitePreview.mockResolvedValue({ status: 'invalid' });

		const result = await load(makeLoadEvent('dead', { id: 'u1', name: 'Alice' }));

		expect(result).toEqual({ state: 'invalid' });
	});
});

describe('/invite/[token] accept action', () => {
	it('anonymous → redirects to /login with an encoded redirectTo back to the invite', async () => {
		try {
			await actions.accept(makeActionEvent('tok abc', null));
			expect.unreachable('expected a redirect to be thrown');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/login?redirectTo=' + encodeURIComponent('/invite/tok abc'));
			}
		}
		expect(acceptInvite).not.toHaveBeenCalled();
	});

	it('accepted → redirects (303) to /groups/:id/members', async () => {
		acceptInvite.mockResolvedValue({ status: 'accepted', groupId: 'g1', memberId: 'm1' });
		try {
			await actions.accept(makeActionEvent('tok', { id: 'u1', name: 'Alice' }));
			expect.unreachable('expected a redirect to be thrown');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/groups/g1/members');
			}
		}
		// Calls the service with the authenticated user's id + name + token.
		expect(acceptInvite).toHaveBeenCalledWith({ userId: 'u1', userName: 'Alice', token: 'tok' });
	});

	it('already_member → redirects (303) to /groups/:id/members (friendly no-op)', async () => {
		acceptInvite.mockResolvedValue({ status: 'already_member', groupId: 'g7' });
		try {
			await actions.accept(makeActionEvent('tok', { id: 'u1', name: 'Alice' }));
			expect.unreachable('expected a redirect to be thrown');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.location).toBe('/groups/g7/members');
			}
		}
	});

	it('invalid → fail(400) with the invalid state + clear message', async () => {
		acceptInvite.mockResolvedValue({ status: 'invalid' });

		const result = (await actions.accept(makeActionEvent('dead', { id: 'u1', name: 'Alice' }))) as {
			status: number;
			data: { state: string; message: string };
		};

		expect(result.status).toBe(400);
		expect(result.data.state).toBe('invalid');
		expect(result.data.message.toLowerCase()).toContain('invalid');
	});

	it('slot_taken → fail(409) with a clear "already been used" message', async () => {
		acceptInvite.mockResolvedValue({ status: 'slot_taken' });

		const result = (await actions.accept(makeActionEvent('tok', { id: 'u1', name: 'Alice' }))) as {
			status: number;
			data: { state: string; message: string };
		};

		expect(result.status).toBe(409);
		expect(result.data.state).toBe('slot_taken');
		expect(result.data.message.toLowerCase()).toContain('already been used');
	});
});
