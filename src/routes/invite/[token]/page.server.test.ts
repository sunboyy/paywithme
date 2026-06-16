import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

// Tests for the `/invite/[token]` accept-flow server logic (task 3.7; PLAN §6.2
// — member-agnostic links).
//
// STRATEGY (mirrors the other route tests): mock the invite SERVICE so nothing
// touches a real DB, then assert the route's CONTRACT — the `load` state machine
// (anonymous → need_auth w/ redirectTo; logged-in valid → ready w/ claimable
// members; logged-in invalid → invalid) and the `accept` action (anonymous →
// redirect to /login w/ redirectTo; selection mode new/existing forwarded;
// accepted/already_member → redirect to /groups/:id/members; slot_taken/invalid
// handled).

const { getInvitePreview, getInviteAcceptInfo, acceptInvite } = vi.hoisted(() => ({
	getInvitePreview: vi.fn(),
	getInviteAcceptInfo: vi.fn(),
	acceptInvite: vi.fn()
}));
vi.mock('$lib/server/invites', () => ({ getInvitePreview, getInviteAcceptInfo, acceptInvite }));

import { load, actions } from './+page.server';

type User = { id: string; name: string };

/** Minimal `load` event with `params.token` + `locals.user`. */
function makeLoadEvent(token: string, user: User | null) {
	return {
		params: { token },
		locals: { user, session: user ? {} : null }
	} as unknown as Parameters<typeof load>[0];
}

/** Build a SvelteKit-action RequestEvent with a form-encoded POST body. */
function makeActionEvent(token: string, fields: Record<string, string>, user: User | null) {
	const body = new URLSearchParams(fields);
	const request = new Request('http://localhost/invite/' + token, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: body.toString()
	});
	return {
		request,
		params: { token },
		locals: { user, session: user ? {} : null }
	} as unknown as Parameters<(typeof actions)['accept']>[0];
}

beforeEach(() => {
	getInvitePreview.mockReset();
	getInviteAcceptInfo.mockReset();
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
		// Anonymous load never exposes the claimable member list.
		expect(getInviteAcceptInfo).not.toHaveBeenCalled();
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

	it('logged-in + valid token → ready with the group name + claimable members (no auto-accept)', async () => {
		getInviteAcceptInfo.mockResolvedValue({
			status: 'valid',
			groupId: 'g1',
			groupName: 'Trip to Tokyo',
			claimableMembers: [{ id: 'm1', displayName: 'Alex' }]
		});

		const result = (await load(makeLoadEvent('tok-abc', { id: 'u1', name: 'Alice' }))) as {
			state: string;
			groupName: string;
			userName: string;
			claimableMembers: { id: string }[];
			acceptForm: unknown;
		};

		expect(result.state).toBe('ready');
		expect(result.groupName).toBe('Trip to Tokyo');
		expect(result.userName).toBe('Alice');
		expect(result.claimableMembers).toEqual([{ id: 'm1', displayName: 'Alex' }]);
		expect(result.acceptForm).toBeDefined();
		// load must NOT mutate.
		expect(acceptInvite).not.toHaveBeenCalled();
	});

	it('logged-in + invalid token → invalid', async () => {
		getInviteAcceptInfo.mockResolvedValue({ status: 'invalid' });

		const result = await load(makeLoadEvent('dead', { id: 'u1', name: 'Alice' }));

		expect(result).toEqual({ state: 'invalid' });
	});
});

describe('/invite/[token] accept action', () => {
	it('anonymous → redirects to /login with an encoded redirectTo back to the invite', async () => {
		try {
			await actions.accept(makeActionEvent('tok abc', { mode: 'new' }, null));
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

	it("mode 'new' accepted → redirects (303) to /groups/:id/members with a { mode: 'new' } selection", async () => {
		acceptInvite.mockResolvedValue({ status: 'accepted', groupId: 'g1', memberId: 'm1' });
		try {
			await actions.accept(makeActionEvent('tok', { mode: 'new' }, { id: 'u1', name: 'Alice' }));
			expect.unreachable('expected a redirect to be thrown');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/groups/g1/members');
			}
		}
		expect(acceptInvite).toHaveBeenCalledWith({
			userId: 'u1',
			userName: 'Alice',
			token: 'tok',
			selection: { mode: 'new' }
		});
	});

	it("mode 'existing' accepted → forwards the chosen memberId in the selection", async () => {
		acceptInvite.mockResolvedValue({ status: 'accepted', groupId: 'g1', memberId: 'm5' });
		try {
			await actions.accept(
				makeActionEvent('tok', { mode: 'existing', memberId: 'm5' }, { id: 'u1', name: 'Alice' })
			);
			expect.unreachable('expected a redirect to be thrown');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
		}
		expect(acceptInvite).toHaveBeenCalledWith({
			userId: 'u1',
			userName: 'Alice',
			token: 'tok',
			selection: { mode: 'existing', memberId: 'm5' }
		});
	});

	it("mode 'existing' with a missing memberId → fail(400), service NOT called", async () => {
		const result = (await actions.accept(
			makeActionEvent('tok', { mode: 'existing' }, { id: 'u1', name: 'Alice' })
		)) as { status: number; data: { form: { valid: boolean } } };

		expect(result.status).toBe(400);
		expect(result.data.form.valid).toBe(false);
		expect(acceptInvite).not.toHaveBeenCalled();
	});

	it('already_member → redirects (303) to /groups/:id/members (friendly no-op)', async () => {
		acceptInvite.mockResolvedValue({ status: 'already_member', groupId: 'g7' });
		try {
			await actions.accept(makeActionEvent('tok', { mode: 'new' }, { id: 'u1', name: 'Alice' }));
			expect.unreachable('expected a redirect to be thrown');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.location).toBe('/groups/g7/members');
			}
		}
	});

	it('invalid → fail(400) with a clear "invalid" message', async () => {
		acceptInvite.mockResolvedValue({ status: 'invalid' });

		const result = (await actions.accept(
			makeActionEvent('dead', { mode: 'new' }, { id: 'u1', name: 'Alice' })
		)) as { status: number; data: { form: { message?: { type: string; text: string } } } };

		expect(result.status).toBe(400);
		expect(result.data.form.message?.type).toBe('error');
		expect(result.data.form.message?.text.toLowerCase()).toContain('invalid');
	});

	it('slot_taken → fail(409) prompting to pick another or join as a new member', async () => {
		acceptInvite.mockResolvedValue({ status: 'slot_taken' });

		const result = (await actions.accept(
			makeActionEvent('tok', { mode: 'existing', memberId: 'm5' }, { id: 'u1', name: 'Alice' })
		)) as { status: number; data: { form: { message?: { type: string; text: string } } } };

		expect(result.status).toBe(409);
		expect(result.data.form.message?.type).toBe('error');
		expect(result.data.form.message?.text.toLowerCase()).toContain('claimed');
	});
});
