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
 * Normalizes the raw `customDays` field into `number | undefined`.
 *
 * The empty string is the whole reason this exists. An HTML form ALWAYS submits
 * its custom-days input, and when the user picked a preset that input is empty —
 * so `customDays` arrives as `''`, not as absent. `z.coerce.number()` turns `''`
 * into `0`, which then fails the ≥1 bound, so every preset (never/30/90/365) got
 * rejected unless the user also filled in a day count. Treating blank as ABSENT
 * is what makes the presets submittable at all.
 *
 * Non-numeric junk also maps to `undefined` rather than `NaN`: only a hand-rolled
 * (no-JS / curl) submission can produce it, and "enter how many days" is a better
 * message than a type error. Range/integer checks live in the `superRefine` below
 * so they run ONLY when the value is actually used.
 */
function normalizeCustomDays(value: unknown): number | undefined {
	if (typeof value === 'number') return Number.isNaN(value) ? undefined : value;
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	if (trimmed === '') return undefined;
	const parsed = Number(trimmed);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Create-key input (PLAN §16.8). Backs `/settings/api-keys/new`, which is a real
 * server-first route: a plain `<form>` POST carries `name`, `scope`, `expiry` and
 * (only when `expiry === 'custom'`) `customDays`, so the whole flow works with JS
 * disabled.
 *
 * The `superRefine` owns the whole custom-expiry rule: a custom expiry REQUIRES a
 * valid day count, and every error is attached to `customDays` so it renders next
 * to that input rather than as a form-level message. When any OTHER choice is
 * selected the field is not validated at all — it is ignored downstream (the
 * service reads the choice, not the raw field), so a stale or junk value left in
 * the input by the browser can neither leak into the minted key's TTL nor block
 * the submission.
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
		customDays: z.preprocess(normalizeCustomDays, z.number().optional())
	})
	.superRefine((data, ctx) => {
		if (data.expiry !== 'custom') return;

		const days = data.customDays;
		const addIssue = (message: string) =>
			ctx.addIssue({ code: 'custom', path: ['customDays'], message });

		if (days === undefined) {
			addIssue('Enter how many days the key should last');
		} else if (!Number.isInteger(days)) {
			addIssue('Enter a whole number of days');
		} else if (days < API_KEY_CUSTOM_EXPIRY_MIN_DAYS) {
			addIssue(`Choose at least ${API_KEY_CUSTOM_EXPIRY_MIN_DAYS} day`);
		} else if (days > API_KEY_CUSTOM_EXPIRY_MAX_DAYS) {
			addIssue(`Choose at most ${API_KEY_CUSTOM_EXPIRY_MAX_DAYS} days`);
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
