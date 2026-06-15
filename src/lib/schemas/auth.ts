// Shared auth Zod schemas (CLAUDE.md: "shared Zod schemas in lib/schemas/").
//
// `registerSchema` is the single source of truth for the `/register` form
// (PLAN §5.1–§5.3, §10): the server validates submissions with it and the
// client `superForm` derives its types from it. Validation rules also encode
// PLAN §12 ("email unique/required") at the input boundary — the magic-link
// plugin treats the address as create-or-load, so we only enforce shape here.

import { z } from 'zod';

/**
 * Display-name field rule — the single source of truth for `user.name` shape
 * (PLAN §5.3, #26). Required, trimmed; rejects empty / whitespace-only (min 1
 * after trim) and caps at 100 chars to bound stored size. Shared by both the
 * register form (`registerSchema.name`) and the post-verify display-name
 * capture form (`displayNameSchema.name`) so the messages never drift.
 */
const nameField = z
	.string()
	.trim()
	.min(1, { message: 'Display name is required' })
	.max(100, { message: 'Display name must be 100 characters or fewer' });

/**
 * Email field rule — the single source of truth for an email input
 * (PLAN §5.1, §12 "email unique/required"). Required; normalized to a trimmed,
 * lowercased canonical form so the magic-link plugin always sees one shape per
 * address. Shared by every auth form that takes an email (`registerSchema`,
 * `loginSchema`) so the rules and their messages never drift between them.
 */
const emailField = z
	.string()
	.trim()
	.toLowerCase()
	.min(1, { message: 'Email is required' })
	.email({ message: 'Enter a valid email address' });

/**
 * Registration input: email + display name (PLAN §5.1, §10).
 *
 * - `email`: required, valid, normalized — see `emailField`.
 * - `name`: required display name — see `nameField`.
 */
export const registerSchema = z.object({
	email: emailField,
	name: nameField
});

/** Inferred, normalized register input — shared by server action + client form. */
export type RegisterInput = z.infer<typeof registerSchema>;

/**
 * Display-name capture input (PLAN §5.3, #26). Collected on the magic-link
 * landing route immediately after the first verification, when better-auth has
 * created the user but not persisted a name. Reuses `nameField` so the trim /
 * empty / length rules and their messages match `registerSchema.name` exactly.
 */
export const displayNameSchema = z.object({
	name: nameField
});

/** Inferred, normalized display-name input — shared by server action + client form. */
export type DisplayNameInput = z.infer<typeof displayNameSchema>;

/**
 * Login input: email only (PLAN §5.1, §5.5). The `/login` magic-link fallback
 * does NOT collect a display name — for an existing account the name is already
 * stored, and a brand-new address routed in via the create-or-load magic link
 * captures its name on the `/auth/magic-link` landing (PLAN §5.3, #26). Reuses
 * `emailField` so the email trim / lowercase / valid rules and their messages
 * match `registerSchema.email` exactly (no drift).
 */
export const loginSchema = z.object({
	email: emailField
});

/** Inferred, normalized login input — shared by server action + client form. */
export type LoginInput = z.infer<typeof loginSchema>;
