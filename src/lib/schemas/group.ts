// Shared group Zod schemas (CLAUDE.md: "shared Zod schemas in lib/schemas/").
//
// These are the single source of truth for the group create / rename form
// inputs (PLAN §6.1, §6.4). Task 3.4's `/groups/new` create page and `/groups`
// rename action validate submissions with these, and their `superForm`s derive
// their types from them — so the rules and messages never drift between the
// server boundary and the client form.
//
// The settlement currency is validated through the shared `currencyCodeSchema`
// (no re-listing of currencies here) so the accepted set stays in lockstep with
// the seeded `currencies` table / `CURRENCY_CODES` constant (PLAN §7.5.1).

import { z } from 'zod';
import { currencyCodeSchema } from './currency';

/**
 * Group-name field rule — the single source of truth for `groups.name` shape
 * (PLAN §6.1). Required, trimmed; rejects empty / whitespace-only (min 1 after
 * trim) and caps at 100 chars to bound stored size. Shared by both the create
 * schema (`createGroupSchema.name`) and the rename schema (`renameGroupSchema`)
 * so the messages never drift.
 */
const groupNameField = z
	.string()
	.trim()
	.min(1, { message: 'Group name is required' })
	.max(100, { message: 'Group name must be 100 characters or fewer' });

/**
 * Create-group input (PLAN §6.1): a name + the required settlement currency the
 * group's balances and settlements are expressed in. `settlementCurrency` reuses
 * the shared `currencyCodeSchema`, so callers must normalize to an uppercase ISO
 * code before validating (`'usd'` / `'BTC'` / unknown are rejected — §7.5.1).
 */
export const createGroupSchema = z.object({
	name: groupNameField,
	settlementCurrency: currencyCodeSchema
});

/** Inferred, normalized create-group input — shared by server action + client form. */
export type CreateGroupInput = z.infer<typeof createGroupSchema>;

/**
 * Rename-group input (PLAN §6.4 — rename is always allowed). Just the name,
 * reusing the same `groupNameField` rule so the trim / empty / length rules and
 * their messages match `createGroupSchema.name` exactly.
 */
export const renameGroupSchema = z.object({
	name: groupNameField
});

/** Inferred, normalized rename-group input — shared by server action + client form. */
export type RenameGroupInput = z.infer<typeof renameGroupSchema>;
