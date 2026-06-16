// Shared invite Zod schemas (CLAUDE.md: "shared Zod schemas in lib/schemas/").
//
// Single source of truth for the invite-link form inputs (PLAN §6.2): the CREATE
// / REVOKE controls on `/groups/[id]/members`, and the ACCEPT choice on
// `/invite/[token]`. The route actions validate submissions with these, and their
// `superForm`s derive their types from them — so the rules never drift between
// the server boundary and the client form.
//
import { z } from 'zod';

/**
 * Create-invite input (PLAN §6.2). Invite links are now **member-agnostic** — they
 * carry NO target member, so creation needs no input beyond the action itself.
 * We keep a trivial empty-object schema so the members page's `superValidate`
 * pattern (and its `superForm`) still have a schema to bind to.
 */
export const createInviteSchema = z.object({});

/** Inferred create-invite input — shared by server action + client form. */
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

/**
 * Accept-invite input (PLAN §6.2 step 3): the invitee's CHOICE of how to join.
 *
 * - `mode = 'new'`      → join as a brand-new member (no `memberId`).
 * - `mode = 'existing'` → claim an existing unlinked slot; `memberId` REQUIRED.
 *
 * The `refine` enforces that an `existing` choice carries a non-empty `memberId`
 * (a no-JS form submits both a radio `mode` and a `<select name="memberId">`).
 */
export const acceptInviteSchema = z
	.object({
		mode: z.enum(['new', 'existing']),
		memberId: z.string().trim().optional()
	})
	.refine((v) => v.mode !== 'existing' || (v.memberId != null && v.memberId.length > 0), {
		message: 'Pick a member to link to.',
		path: ['memberId']
	});

/** Inferred accept-invite input — shared by the accept route + its client form. */
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

/**
 * Revoke-invite input (PLAN §6.2): which invite link to revoke. Non-empty string
 * id (an in-app `crypto.randomUUID()` text PK — see `groups-schema.ts`); we only
 * assert non-empty here and let the service enforce that the invite actually
 * belongs to the group (never trust a client-supplied id to be valid).
 */
export const revokeInviteSchema = z.object({
	inviteId: z.string().trim().min(1, { message: 'An invite is required' })
});

/** Inferred, normalized revoke-invite input — shared by server action + client form. */
export type RevokeInviteInput = z.infer<typeof revokeInviteSchema>;
