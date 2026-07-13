// Shared API-key form schemas (CLAUDE.md: "shared Zod schemas in lib/schemas/";
// PLAN §16.8 key-management UX).
//
// Single source of truth for BOTH sides of the `/settings/api-keys/new` create
// form and the `/settings` revoke action: the server validates submissions with
// these, and the client `superForm` derives its types from them. Everything here
// is shape/range validation only — ownership and the actual mint/revoke are
// enforced server-side in `lib/server/api-keys.ts`.

import { z } from 'zod';

/**
 * The two v1 scopes (PLAN §16.2), as the form sees them. `write ⊇ read`.
 *
 * This mirrors `ApiScope` in `lib/server/api/scope.ts` — that module owns the
 * ENCODING (`scopeToPermissions`, which is what the create service actually
 * stores), while this is the INPUT boundary. They are deliberately kept as two
 * literal unions rather than one import so the browser bundle never pulls a
 * `lib/server` module in; `api-keys.ts` asserts they agree.
 */
export const API_KEY_SCOPES = ['read', 'write'] as const;
export type ApiKeyScopeInput = (typeof API_KEY_SCOPES)[number];

/**
 * Expiry choices (PLAN §16.8): **Never (default)** + 30/90/365-day presets + a
 * custom option. The preset values are days, as strings, because they arrive from
 * a plain no-JS `<input type="radio">` — the schema is what turns them back into
 * a typed choice.
 */
export const API_KEY_EXPIRY_CHOICES = ['never', '30', '90', '365', 'custom'] as const;
export type ApiKeyExpiryChoice = (typeof API_KEY_EXPIRY_CHOICES)[number];

/**
 * Bounds on the CUSTOM expiry, in days.
 *
 * These are NOT arbitrary: the `@better-auth/api-key` plugin validates
 * `expiresIn` against its `keyExpiration` config and rejects anything outside
 * `minExpiresIn` (default **1** day) … `maxExpiresIn` (default **365** days) with
 * a 400. `auth.ts` does not override those defaults, so validating to the SAME
 * bounds here turns what would be an opaque plugin error into a friendly,
 * field-level form message. The 365 ceiling is also why the presets stop at 365.
 */
export const API_KEY_CUSTOM_EXPIRY_MIN_DAYS = 1;
export const API_KEY_CUSTOM_EXPIRY_MAX_DAYS = 365;

/**
 * Max key-name length. Matches the plugin's `maximumNameLength` default (32) for
 * the same reason as the expiry bounds — the plugin 400s past it, so we catch it
 * at the form boundary with a readable message.
 */
export const API_KEY_NAME_MAX_LENGTH = 32;

/**
 * Create-key input (PLAN §16.8). Backs `/settings/api-keys/new`, which is a real
 * server-first route: a plain `<form>` POST carries `name`, `scope`, `expiry` and
 * (only when `expiry === 'custom'`) `customDays`, so the whole flow works with JS
 * disabled.
 *
 * The `superRefine` encodes the one cross-field rule: a custom expiry REQUIRES a
 * day count, and the error is attached to `customDays` so it renders next to that
 * input rather than as a form-level message. When any other choice is selected,
 * `customDays` is ignored entirely (the service reads the choice, not the raw
 * field), so a stale value left in the input by the browser can never leak into
 * the minted key's TTL.
 */
export const createApiKeySchema = z
	.object({
		name: z
			.string()
			.trim()
			.min(1, { message: 'Give the key a name so you can recognize it later' })
			.max(API_KEY_NAME_MAX_LENGTH, {
				message: `Name must be ${API_KEY_NAME_MAX_LENGTH} characters or fewer`
			}),
		// Default `read` = least privilege: if the field were ever missing, the key
		// that gets minted is the one that cannot move money (PLAN §16.2).
		scope: z.enum(API_KEY_SCOPES).default('read'),
		// Default `never` = PLAN §16.8's stated default (non-expiring, §16.2).
		expiry: z.enum(API_KEY_EXPIRY_CHOICES).default('never'),
		// `coerce` because a no-JS form field always arrives as a string.
		customDays: z.coerce
			.number()
			.int({ message: 'Enter a whole number of days' })
			.min(API_KEY_CUSTOM_EXPIRY_MIN_DAYS, {
				message: `Choose at least ${API_KEY_CUSTOM_EXPIRY_MIN_DAYS} day`
			})
			.max(API_KEY_CUSTOM_EXPIRY_MAX_DAYS, {
				message: `Choose at most ${API_KEY_CUSTOM_EXPIRY_MAX_DAYS} days`
			})
			.optional()
	})
	.superRefine((data, ctx) => {
		if (data.expiry === 'custom' && data.customDays === undefined) {
			ctx.addIssue({
				code: 'custom',
				path: ['customDays'],
				message: 'Enter how many days the key should last'
			});
		}
	});

/** Inferred create-key input — shared by the create action + its form. */
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

/**
 * Revoke-key input (PLAN §16.8). Backs the `/settings` `?/revokeApiKey` action,
 * which works without JS via a plain `<form>` carrying the key `id` in a hidden
 * field (the passkey-delete pattern). Only shape is validated here: the service
 * scopes the delete to the caller's OWN keys, so a forged id from another user
 * cannot revoke anything.
 */
export const revokeApiKeySchema = z.object({
	id: z.string().min(1, { message: 'An API key id is required' })
});

/** Inferred revoke-key input — shared by the `/settings` action + form. */
export type RevokeApiKeyInput = z.infer<typeof revokeApiKeySchema>;
