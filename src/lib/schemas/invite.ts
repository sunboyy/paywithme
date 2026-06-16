// Shared invite Zod schemas (CLAUDE.md: "shared Zod schemas in lib/schemas/").
//
// Single source of truth for the invite-link form inputs on
// `/groups/[id]/members` (task 3.6; PLAN §6.2). The members page's invite
// actions validate submissions with these, and their `superForm`s derive their
// types from them — so the rules never drift between the server boundary and the
// client form.
//
// The accept-side (`/invite/[token]`) is task 3.7 and is NOT modelled here; this
// task only covers CREATE / COPY / REVOKE management.

import { z } from 'zod';

/**
 * Create-invite input (PLAN §6.2): an optional target member.
 *
 * - `memberId` ABSENT or EMPTY (''), → an **open** invite (accept creates a new
 *   member). HTML `<select>`s submit '' for the "Open invite" option, so we
 *   normalize empty/whitespace-only → `undefined` (open). A non-empty string is
 *   a member-targeted invite; the service then validates the target is an
 *   eligible unlinked, active, in-group slot.
 *
 * `.optional()` after the transform lets the field be omitted entirely (no-JS
 * form that simply doesn't render a target) and still resolve to "open".
 */
export const createInviteSchema = z.object({
	memberId: z
		.string()
		.trim()
		.transform((v) => (v.length > 0 ? v : undefined))
		.optional()
});

/** Inferred, normalized create-invite input — shared by server action + client form. */
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

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
