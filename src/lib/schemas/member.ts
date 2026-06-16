// Shared member Zod schemas (CLAUDE.md: "shared Zod schemas in lib/schemas/").
//
// Single source of truth for the member-management form inputs on
// `/groups/[id]/members` (task 3.5; PLAN §6.1–§6.3). The members page actions
// validate submissions with these, and their `superForm`s derive their types
// from them — so the rules and messages never drift between the server boundary
// and the client form.
//
// Invite-link schemas are intentionally NOT here: invite create/copy/revoke is
// task 3.6, which adds its own schema(s).

import { z } from 'zod';

/**
 * Member display-name field rule — the single source of truth for
 * `members.display_name` shape (PLAN §6.1–§6.2: a display name, editable in
 * member management). Required, trimmed; rejects empty / whitespace-only (min 1
 * after trim) and caps at 100 chars to bound stored size (matches the group-name
 * cap in `schemas/group.ts`). Shared by the add + rename schemas so the messages
 * never drift.
 */
const memberDisplayNameField = z
	.string()
	.trim()
	.min(1, { message: 'Display name is required' })
	.max(100, { message: 'Display name must be 100 characters or fewer' });

/**
 * Member-id field rule — a non-empty string identifying the target member slot.
 * The id is an in-app `crypto.randomUUID()` text PK (see `groups-schema.ts`); we
 * only assert non-empty here and let the service enforce that the member
 * actually belongs to the group (never trust a client-supplied id to be valid).
 */
const memberIdField = z.string().trim().min(1, { message: 'A member is required' });

/**
 * Add-member input (PLAN §6.1): just a display name. The created member is a NEW
 * UNLINKED slot (`user_id = null`) — a participant for someone who may not have
 * an account; linking happens via invite accept (task 3.6/3.7), not here.
 */
export const addMemberSchema = z.object({
	displayName: memberDisplayNameField
});

/** Inferred, normalized add-member input — shared by server action + client form. */
export type AddMemberInput = z.infer<typeof addMemberSchema>;

/**
 * Rename-member input (PLAN §6.2: display name editable in member management):
 * which member + the new display name. Reuses `memberDisplayNameField` so the
 * trim / empty / length rules and messages match `addMemberSchema.displayName`.
 */
export const renameMemberSchema = z.object({
	memberId: memberIdField,
	displayName: memberDisplayNameField
});

/** Inferred, normalized rename-member input — shared by server action + client form. */
export type RenameMemberInput = z.infer<typeof renameMemberSchema>;

/**
 * Bare member-id input — used by the remove + reactivate actions (PLAN §6.3),
 * which only need to identify the target slot (the action itself decides
 * soft-deactivate vs hard-delete, and reactivate is a flag flip).
 */
export const memberIdSchema = z.object({
	memberId: memberIdField
});

/** Inferred member-id input — shared by the remove + reactivate actions/forms. */
export type MemberIdInput = z.infer<typeof memberIdSchema>;
