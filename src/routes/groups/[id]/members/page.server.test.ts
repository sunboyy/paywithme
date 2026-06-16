import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isRedirect, isHttpError } from '@sveltejs/kit';

// Tests for the `/groups/[id]/members` server logic (task 3.5; PLAN §6.1–§6.3).
//
// STRATEGY (mirrors `settings/page.server.test.ts`): mock the group + member
// services so nothing touches a real DB; build minimal RequestEvents and assert
// the route's CONTRACT — auth guard, access→404, validation→fail(400) with the
// service NOT called, valid→service called once with the right args, and the
// service error model (`GroupAccessError`/`MemberNotFoundError`) → `error(404)`.

// Everything referenced inside the hoisted `vi.mock` factories must be created
// in `vi.hoisted` too (the mocks are hoisted above any top-level declarations) —
// including the error CLASSES, so the route's `instanceof` checks work against
// exactly what the mocked services throw.
const {
	getGroupForUser,
	listMembers,
	addMember,
	renameMember,
	removeMember,
	reactivateMember,
	createInvite,
	listActiveInvites,
	revokeInvite,
	GroupAccessError,
	MemberNotFoundError,
	InviteNotFoundError
} = vi.hoisted(() => {
	class GroupAccessError extends Error {
		readonly code = 'group_access' as const;
	}
	class MemberNotFoundError extends Error {
		readonly code = 'member_not_found' as const;
	}
	class InviteNotFoundError extends Error {
		readonly code = 'invite_not_found' as const;
	}
	return {
		getGroupForUser: vi.fn(),
		listMembers: vi.fn(),
		addMember: vi.fn(),
		renameMember: vi.fn(),
		removeMember: vi.fn(),
		reactivateMember: vi.fn(),
		createInvite: vi.fn(),
		listActiveInvites: vi.fn(),
		revokeInvite: vi.fn(),
		GroupAccessError,
		MemberNotFoundError,
		InviteNotFoundError
	};
});

vi.mock('$lib/server/groups', () => ({ getGroupForUser, GroupAccessError }));
vi.mock('$lib/server/members', () => ({
	listMembers,
	addMember,
	renameMember,
	removeMember,
	reactivateMember,
	MemberNotFoundError
}));
vi.mock('$lib/server/invites', () => ({
	createInvite,
	listActiveInvites,
	revokeInvite,
	InviteNotFoundError
}));

import { load, actions } from './+page.server';

type User = { id: string; name: string };

/** Minimal `load` event with `locals.user` + route params + request `url`. */
function makeLoadEvent(user: User | null, id = 'g1') {
	return {
		params: { id },
		locals: { user, session: user ? {} : null },
		url: new URL(`http://localhost/groups/${id}/members`)
	} as unknown as Parameters<typeof load>[0];
}

/** Build a SvelteKit-action RequestEvent with a form-encoded POST body. */
function makeActionEvent(fields: Record<string, string>, user: User | null, id = 'g1') {
	const body = new URLSearchParams(fields);
	const request = new Request('http://localhost/groups/g1/members', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: body.toString()
	});
	return {
		request,
		params: { id },
		locals: { user, session: user ? {} : null }
	} as unknown as Parameters<(typeof actions)['addMember']>[0];
}

const AUTH_USER: User = { id: 'u1', name: 'Alice' };

beforeEach(() => {
	getGroupForUser.mockReset();
	listMembers.mockReset();
	addMember.mockReset();
	renameMember.mockReset();
	removeMember.mockReset();
	reactivateMember.mockReset();
	createInvite.mockReset();
	listActiveInvites.mockReset();
	revokeInvite.mockReset();
	// Default the invite list to empty so member-focused load tests don't 500.
	listActiveInvites.mockResolvedValue([]);
});

describe('/groups/[id]/members load', () => {
	it('redirects an anonymous user to /login and never fetches the group', async () => {
		try {
			await load(makeLoadEvent(null));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/login');
			}
		}
		expect(getGroupForUser).not.toHaveBeenCalled();
	});

	it('throws error(404) when the group is not accessible (null)', async () => {
		getGroupForUser.mockResolvedValueOnce(null);
		try {
			await load(makeLoadEvent(AUTH_USER));
			expect.unreachable('expected a 404');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(404);
		}
		expect(listMembers).not.toHaveBeenCalled();
	});

	it('returns the group + members + seeded forms for an accessible group', async () => {
		getGroupForUser.mockResolvedValueOnce({
			id: 'g1',
			name: 'Trip',
			settlementCurrency: 'THB'
		});
		listMembers.mockResolvedValueOnce([
			{ id: 'm1', displayName: 'Alex', userId: null, deactivatedAt: null, isLinked: false }
		]);

		const result = (await load(makeLoadEvent(AUTH_USER))) as {
			viewerUserId: string;
			group: { id: string; name: string };
			members: unknown[];
			invites: unknown[];
			origin: string;
			addForm: unknown;
			createInviteForm: unknown;
			revokeInviteForm: unknown;
		};

		expect(listMembers).toHaveBeenCalledWith({ userId: 'u1', groupId: 'g1' });
		expect(listActiveInvites).toHaveBeenCalledWith({ userId: 'u1', groupId: 'g1' });
		expect(result.viewerUserId).toBe('u1');
		expect(result.group).toMatchObject({ id: 'g1', name: 'Trip' });
		expect(result.members).toHaveLength(1);
		// Invite-link load additions (task 3.6): the active list + the request origin
		// for the absolute `${origin}/invite/${token}` URL, plus seeded forms.
		expect(result.invites).toEqual([]);
		expect(result.origin).toBe('http://localhost');
		expect(result.addForm).toBeDefined();
		expect(result.createInviteForm).toBeDefined();
		expect(result.revokeInviteForm).toBeDefined();
	});

	it('returns the active invite links from listActiveInvites', async () => {
		getGroupForUser.mockResolvedValueOnce({ id: 'g1', name: 'Trip', settlementCurrency: 'THB' });
		listMembers.mockResolvedValueOnce([]);
		listActiveInvites.mockResolvedValueOnce([
			{
				id: 'i1',
				token: 'tok',
				expiresAt: '2026-07-01T00:00:00.000Z',
				createdAt: '2026-06-16T00:00:00.000Z'
			}
		]);

		const result = (await load(makeLoadEvent(AUTH_USER))) as { invites: { id: string }[] };
		expect(result.invites).toHaveLength(1);
		expect(result.invites[0].id).toBe('i1');
	});

	it('degrades to an empty member list when listMembers throws a generic error', async () => {
		getGroupForUser.mockResolvedValueOnce({ id: 'g1', name: 'Trip', settlementCurrency: 'THB' });
		listMembers.mockRejectedValueOnce(new Error('list backend down'));

		const result = (await load(makeLoadEvent(AUTH_USER))) as { members: unknown[] };
		expect(result.members).toEqual([]);
	});

	it('degrades to an empty invite list when listActiveInvites throws a generic error', async () => {
		getGroupForUser.mockResolvedValueOnce({ id: 'g1', name: 'Trip', settlementCurrency: 'THB' });
		listMembers.mockResolvedValueOnce([]);
		listActiveInvites.mockReset();
		listActiveInvites.mockRejectedValueOnce(new Error('invites backend down'));

		const result = (await load(makeLoadEvent(AUTH_USER))) as { invites: unknown[] };
		expect(result.invites).toEqual([]);
	});
});

describe('/groups/[id]/members ?/addMember action', () => {
	it('redirects anonymous to /login and never calls the service', async () => {
		try {
			await actions.addMember(makeActionEvent({ displayName: 'Alex' }, null));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
		}
		expect(addMember).not.toHaveBeenCalled();
	});

	it('returns fail(400) and does NOT call the service on an empty display name', async () => {
		const result = (await actions.addMember(makeActionEvent({ displayName: '' }, AUTH_USER))) as {
			status: number;
			data: { form: { valid: boolean } };
		};
		expect(result.status).toBe(400);
		expect(result.data.form.valid).toBe(false);
		expect(addMember).not.toHaveBeenCalled();
	});

	it('calls addMember once with the right args on a valid submit', async () => {
		addMember.mockResolvedValueOnce({ id: 'm9' });
		const result = await actions.addMember(makeActionEvent({ displayName: 'Alex' }, AUTH_USER));

		expect(addMember).toHaveBeenCalledTimes(1);
		expect(addMember).toHaveBeenCalledWith({ userId: 'u1', groupId: 'g1', displayName: 'Alex' });
		const msg = (result as { form: { message?: { type: string } } }).form.message;
		expect(msg?.type).toBe('success');
	});

	it('maps a GroupAccessError to error(404)', async () => {
		addMember.mockRejectedValueOnce(new GroupAccessError());
		try {
			await actions.addMember(makeActionEvent({ displayName: 'Alex' }, AUTH_USER));
			expect.unreachable('expected a 404');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(404);
		}
	});
});

describe('/groups/[id]/members ?/renameMember action', () => {
	it('redirects anonymous to /login and never calls the service', async () => {
		try {
			await actions.renameMember(
				makeActionEvent({ memberId: 'm1', displayName: 'New name' }, null)
			);
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/login');
			}
		}
		expect(renameMember).not.toHaveBeenCalled();
	});

	it('returns fail(400) and does NOT call the service when fields are missing', async () => {
		const result = (await actions.renameMember(
			makeActionEvent({ memberId: '', displayName: '' }, AUTH_USER)
		)) as { status: number; data: { form: { valid: boolean } } };
		expect(result.status).toBe(400);
		expect(renameMember).not.toHaveBeenCalled();
	});

	it('calls renameMember once with the right args on a valid submit', async () => {
		renameMember.mockResolvedValueOnce({ id: 'm1' });
		await actions.renameMember(
			makeActionEvent({ memberId: 'm1', displayName: 'New name' }, AUTH_USER)
		);
		expect(renameMember).toHaveBeenCalledWith({
			userId: 'u1',
			groupId: 'g1',
			memberId: 'm1',
			displayName: 'New name'
		});
	});

	it('maps a MemberNotFoundError to error(404)', async () => {
		renameMember.mockRejectedValueOnce(new MemberNotFoundError());
		try {
			await actions.renameMember(makeActionEvent({ memberId: 'm1', displayName: 'X' }, AUTH_USER));
			expect.unreachable('expected a 404');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(404);
		}
	});
});

describe('/groups/[id]/members ?/removeMember action', () => {
	it('redirects anonymous to /login and never calls the service', async () => {
		try {
			await actions.removeMember(makeActionEvent({ memberId: 'm1' }, null));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/login');
			}
		}
		expect(removeMember).not.toHaveBeenCalled();
	});

	it('returns fail(400) and does NOT call the service on a missing memberId', async () => {
		const result = (await actions.removeMember(makeActionEvent({}, AUTH_USER))) as {
			status: number;
			data: { form: { valid: boolean } };
		};
		expect(result.status).toBe(400);
		expect(removeMember).not.toHaveBeenCalled();
	});

	it('calls removeMember once with the right args on a valid submit', async () => {
		removeMember.mockResolvedValueOnce({ action: 'hard_delete' });
		await actions.removeMember(makeActionEvent({ memberId: 'm1' }, AUTH_USER));
		expect(removeMember).toHaveBeenCalledWith({ userId: 'u1', groupId: 'g1', memberId: 'm1' });
	});

	it('maps a MemberNotFoundError to error(404)', async () => {
		removeMember.mockRejectedValueOnce(new MemberNotFoundError());
		try {
			await actions.removeMember(makeActionEvent({ memberId: 'm1' }, AUTH_USER));
			expect.unreachable('expected a 404');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(404);
		}
	});
});

describe('/groups/[id]/members ?/reactivate action', () => {
	it('redirects anonymous to /login and never calls the service', async () => {
		try {
			await actions.reactivate(makeActionEvent({ memberId: 'm1' }, null));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/login');
			}
		}
		expect(reactivateMember).not.toHaveBeenCalled();
	});

	it('returns fail(400) and does NOT call the service on a missing memberId', async () => {
		const result = (await actions.reactivate(makeActionEvent({}, AUTH_USER))) as {
			status: number;
			data: { form: { valid: boolean } };
		};
		expect(result.status).toBe(400);
		expect(reactivateMember).not.toHaveBeenCalled();
	});

	it('calls reactivateMember once with the right args on a valid submit', async () => {
		reactivateMember.mockResolvedValueOnce({ id: 'm1' });
		await actions.reactivate(makeActionEvent({ memberId: 'm1' }, AUTH_USER));
		expect(reactivateMember).toHaveBeenCalledWith({ userId: 'u1', groupId: 'g1', memberId: 'm1' });
	});

	it('maps a GroupAccessError to error(404)', async () => {
		reactivateMember.mockRejectedValueOnce(new GroupAccessError());
		try {
			await actions.reactivate(makeActionEvent({ memberId: 'm1' }, AUTH_USER));
			expect.unreachable('expected a 404');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(404);
		}
	});
});

describe('/groups/[id]/members ?/createInvite action', () => {
	it('redirects anonymous to /login and never calls the service', async () => {
		try {
			await actions.createInvite(makeActionEvent({}, null));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/login');
			}
		}
		expect(createInvite).not.toHaveBeenCalled();
	});

	it('calls createInvite once with a MEMBER-AGNOSTIC link (no memberId)', async () => {
		createInvite.mockResolvedValueOnce({ id: 'i1', token: 't' });
		const result = await actions.createInvite(makeActionEvent({}, AUTH_USER));

		expect(createInvite).toHaveBeenCalledTimes(1);
		// Member-agnostic: only userId + groupId, never a target member.
		expect(createInvite).toHaveBeenCalledWith({ userId: 'u1', groupId: 'g1' });
		const msg = (result as { form: { message?: { type: string } } }).form.message;
		expect(msg?.type).toBe('success');
	});

	it('maps a GroupAccessError to error(404)', async () => {
		createInvite.mockRejectedValueOnce(new GroupAccessError());
		try {
			await actions.createInvite(makeActionEvent({}, AUTH_USER));
			expect.unreachable('expected a 404');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(404);
		}
	});
});

describe('/groups/[id]/members ?/revokeInvite action', () => {
	it('redirects anonymous to /login and never calls the service', async () => {
		try {
			await actions.revokeInvite(makeActionEvent({ inviteId: 'i1' }, null));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/login');
			}
		}
		expect(revokeInvite).not.toHaveBeenCalled();
	});

	it('returns fail(400) and does NOT call the service on a missing inviteId', async () => {
		const result = (await actions.revokeInvite(makeActionEvent({}, AUTH_USER))) as {
			status: number;
			data: { form: { valid: boolean } };
		};
		expect(result.status).toBe(400);
		expect(revokeInvite).not.toHaveBeenCalled();
	});

	it('calls revokeInvite once with the right args on a valid submit', async () => {
		revokeInvite.mockResolvedValueOnce(undefined);
		await actions.revokeInvite(makeActionEvent({ inviteId: 'i1' }, AUTH_USER));
		expect(revokeInvite).toHaveBeenCalledWith({ userId: 'u1', groupId: 'g1', inviteId: 'i1' });
	});

	it('maps an InviteNotFoundError to error(404)', async () => {
		revokeInvite.mockRejectedValueOnce(new InviteNotFoundError());
		try {
			await actions.revokeInvite(makeActionEvent({ inviteId: 'i1' }, AUTH_USER));
			expect.unreachable('expected a 404');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(404);
		}
	});
});
