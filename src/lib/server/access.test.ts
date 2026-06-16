import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isRedirect, isHttpError } from '@sveltejs/kit';

// Unit tests for the canonical ROUTE-enforcement layer (task 3.8; PLAN §12).
//
// STRATEGY (mirrors `groups/[id]/members/page.server.test.ts`): mock the SERVICE
// primitive `$lib/server/groups` so nothing touches a real DB, build a minimal
// `locals`, and assert the guard CONTRACT — the redirect-vs-404 throw semantics
// and that `requireGroupAccess` does NOT consult the service for an anonymous
// caller (the auth check short-circuits first). `safeRedirectTo` is the real
// (pure) helper so the optional `redirectTo` sanitization is tested end-to-end.

const { getGroupForUser } = vi.hoisted(() => ({ getGroupForUser: vi.fn() }));

// Mock ONLY the service primitive this layer builds on. We keep the real
// `Group` type via the mock's resolved value shape; `safeRedirectTo` stays real.
vi.mock('$lib/server/groups', () => ({ getGroupForUser }));

import { requireUser, requireGroupAccess } from './access';

type User = { id: string; name: string };

const AUTH_USER: User = { id: 'u1', name: 'Alice' };

/** Minimal `App.Locals` with a user (or anonymous). */
function makeLocals(user: User | null): App.Locals {
	return { user, session: user ? {} : null } as unknown as App.Locals;
}

beforeEach(() => {
	getGroupForUser.mockReset();
});

describe('requireUser', () => {
	it('returns the user when locals.user is set', () => {
		expect(requireUser(makeLocals(AUTH_USER))).toBe(AUTH_USER);
	});

	it('throws redirect(303, /login) when anonymous', () => {
		try {
			requireUser(makeLocals(null));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/login');
			}
		}
	});

	it('carries a sanitized redirectTo in the login location when provided', () => {
		try {
			requireUser(makeLocals(null), { redirectTo: '/groups/g1/members' });
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				// The path is encoded into the query param.
				expect(e.location).toBe('/login?redirectTo=' + encodeURIComponent('/groups/g1/members'));
			}
		}
	});

	it('falls back to a plain /login when redirectTo is unsafe (open redirect)', () => {
		try {
			requireUser(makeLocals(null), { redirectTo: '//evil.com' });
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			// An unsafe value is dropped (no `?redirectTo=` payload), not forwarded.
			if (isRedirect(e)) expect(e.location).toBe('/login');
		}
	});

	it('does not call the access primitive at all (auth-only check)', () => {
		expect(() => requireUser(makeLocals(null))).toThrow();
		expect(getGroupForUser).not.toHaveBeenCalled();
	});
});

describe('requireGroupAccess', () => {
	it('throws redirect to /login when anonymous and never fetches the group', async () => {
		try {
			await requireGroupAccess({ locals: makeLocals(null), groupId: 'g1' });
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/login');
			}
		}
		// The auth check short-circuits BEFORE any DB-backed access fetch.
		expect(getGroupForUser).not.toHaveBeenCalled();
	});

	it('throws error(404) when getGroupForUser returns null (no access / soft-deleted)', async () => {
		getGroupForUser.mockResolvedValueOnce(null);
		try {
			await requireGroupAccess({ locals: makeLocals(AUTH_USER), groupId: 'g1' });
			expect.unreachable('expected a 404');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(404);
		}
		expect(getGroupForUser).toHaveBeenCalledWith('u1', 'g1');
	});

	it('returns { user, group } when getGroupForUser returns a group', async () => {
		const group = { id: 'g1', name: 'Trip', settlementCurrency: 'THB' };
		getGroupForUser.mockResolvedValueOnce(group);

		const result = await requireGroupAccess({ locals: makeLocals(AUTH_USER), groupId: 'g1' });

		expect(result.user).toBe(AUTH_USER);
		expect(result.group).toBe(group);
		expect(getGroupForUser).toHaveBeenCalledWith('u1', 'g1');
	});
});
