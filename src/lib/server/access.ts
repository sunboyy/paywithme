// Canonical ROUTE-enforcement layer for group access (task 3.8; PLAN §12).
//
// PLAN §12: "Authorization is group-membership based only (no per-action roles in
// v1) … the single enforced check is that the requesting user has access to the
// group (via a linked member). Enforce in lib/server."
//
// LAYERING (one-directional, no cycle):
//   route `load`/`actions`  →  access.ts (THIS module)  →  groups.ts (SERVICE)
// `groups.ts#userHasGroupAccess` / `getGroupForUser` is the underlying SERVICE
// PRIMITIVE — the pure membership check + access-checked fetch (task 3.3). This
// module is the thin ROUTE guard built ON TOP of it: it turns "anonymous" into a
// `redirect(303,'/login')` and "no access / not found / soft-deleted" into an
// `error(404)`, so route handlers stop hand-rolling the auth+access dance and all
// funnel through the single check PLAN §12 mandates. `access.ts` imports from
// `groups.ts` and NEVER the reverse (importing back would create a cycle).
//
// TRAP — both helpers THROW SvelteKit control-flow objects (`redirect`/`error`).
// Call them at the TOP of a handler, OUTSIDE any try/catch that would swallow the
// throw and defeat the guard (consistent with the notes in
// `settings/+page.server.ts` and `groups/[id]/members/+page.server.ts`):
//   const { user, group } = await requireGroupAccess({ locals, groupId: params.id });

import { error, redirect } from '@sveltejs/kit';
import { safeRedirectTo } from '$lib/redirect';
import { getGroupForUser, type Group } from './groups';

/** The authenticated user as resolved into `locals` by `hooks.server.ts`. */
type AuthedUser = NonNullable<App.Locals['user']>;

/**
 * Require an authenticated session. Returns the non-null `user` when present, or
 * THROWS `redirect(303, '/login')` for an anonymous caller. Use this for any
 * "must be logged in" route (`load` or `action`).
 *
 * Optionally pass `{ redirectTo }` to preserve a return path: the login URL
 * becomes `'/login?redirectTo=' + encodeURIComponent(<sanitized path>)`. The path
 * is sanitized through `safeRedirectTo` (it is often attacker-controlled), so an
 * unsafe value (off-origin, scheme, protocol-relative) falls back to a plain
 * `/login` rather than carrying an open-redirect payload.
 */
export function requireUser(locals: App.Locals, options: { redirectTo?: string } = {}): AuthedUser {
	if (locals.user) {
		return locals.user;
	}

	const safe = safeRedirectTo(options.redirectTo);
	if (safe) {
		redirect(303, '/login?redirectTo=' + encodeURIComponent(safe));
	}
	redirect(303, '/login');
}

/**
 * Require that the caller is authenticated AND has access to `groupId`. Calls
 * `requireUser` first (anonymous → `redirect(303,'/login')`), then the SERVICE
 * primitive `getGroupForUser`; a `null` result — meaning NO ACCESS, NOT FOUND, or
 * SOFT-DELETED — THROWS `error(404)`.
 *
 * The three "you can't see this group" outcomes are deliberately conflated into a
 * single 404 so we never leak the EXISTENCE of groups the user can't access
 * (PLAN §12 "don't leak"): an attacker probing ids can't distinguish a group they
 * lack access to from one that doesn't exist.
 *
 * Returns BOTH the `user` and the already-loaded `group` so the caller doesn't
 * re-query. THROWS control flow — call outside any try/catch (see module note).
 */
export async function requireGroupAccess({
	locals,
	groupId
}: {
	locals: App.Locals;
	groupId: string;
}): Promise<{ user: AuthedUser; group: Group }> {
	const user = requireUser(locals);

	const group = await getGroupForUser(user.id, groupId);
	if (!group) {
		error(404, 'Group not found');
	}

	return { user, group };
}
