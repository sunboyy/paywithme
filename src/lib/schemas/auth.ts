// Shared auth Zod schemas (CLAUDE.md: "shared Zod schemas in lib/schemas/").
//
// `registerSchema` is the single source of truth for the `/register` form
// (PLAN §5.1–§5.3, §10): the server validates submissions with it and the
// client `superForm` derives its types from it. Validation rules also encode
// PLAN §12 ("email unique/required") at the input boundary — the magic-link
// plugin treats the address as create-or-load, so we only enforce shape here.

import { z } from 'zod';

/**
 * Registration input: email + display name (PLAN §5.1, §10).
 *
 * - `email`: required, must be a valid address, normalized to a trimmed,
 *   lowercased canonical form so the magic-link plugin always sees one shape
 *   per address (PLAN §12 "email unique/required").
 * - `name`: required display name, trimmed; rejects empty / whitespace-only
 *   (min 1 after trim) and caps at 100 chars to bound stored size.
 */
export const registerSchema = z.object({
	email: z
		.string()
		.trim()
		.toLowerCase()
		.min(1, { message: 'Email is required' })
		.email({ message: 'Enter a valid email address' }),
	name: z
		.string()
		.trim()
		.min(1, { message: 'Display name is required' })
		.max(100, { message: 'Display name must be 100 characters or fewer' })
});

/** Inferred, normalized register input — shared by server action + client form. */
export type RegisterInput = z.infer<typeof registerSchema>;
