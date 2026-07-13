// API-key scope model + write-guard (PLAN §16.2).
//
// Two scopes, `read` and `write`, with `write ⊇ read` (a write key can also
// read). Enforcement is ONE shared guard on every mutating endpoint: a `read`
// key that attempts a write gets a 403 `forbidden_scope` — the high-value
// money-safety affordance against a leaked or prompt-injected read key. There are
// NO finer-grained, per-resource scopes in v1.
//
// ── Encoding convention (how a scope lives in the plugin's `permissions`) ──
// The `@better-auth/api-key` plugin stores per-key `permissions` as
// `Record<string, string[]>` (resource → actions). We use a SINGLE synthetic
// resource, `api`, and encode the scope as the actions it grants:
//
//     read  key →  { api: ['read'] }
//     write key →  { api: ['read', 'write'] }   // write ⊇ read: BOTH actions
//
// A key is `write` iff its `api` actions include `'write'`; everything else
// (only `read`, an empty list, a missing `api` resource, or `null` permissions)
// is treated as `read` — least privilege by default, so a malformed/legacy key
// can never move money. The key-management ticket (#23) MUST create keys through
// `scopeToPermissions` so the stored shape always matches what this guard reads.

import type { ApiKeyPrincipal } from './principal';
import { forbiddenScope } from './errors';

/** The two v1 scopes (PLAN §16.2). `write ⊇ read`. */
export type ApiScope = 'read' | 'write';

/**
 * The single synthetic resource key under which the scope is stored in the
 * plugin's `permissions` map. Not a real REST resource — there are no
 * per-resource scopes in v1; it is just the slot the `read`/`write` actions live
 * in. Exported so #23's key-creation stays in lock-step with this reader.
 */
export const API_SCOPE_RESOURCE = 'api';

/** The action string that distinguishes a write key. */
const WRITE_ACTION: ApiScope = 'write';

/**
 * Encode a scope into the plugin `permissions` shape (see the module's encoding
 * note). `write ⊇ read`, so a write key carries BOTH actions. The key-management
 * ticket (#23) uses this so the stored shape always matches `getApiKeyScope`.
 */
export function scopeToPermissions(scope: ApiScope): Record<string, string[]> {
	return { [API_SCOPE_RESOURCE]: scope === 'write' ? ['read', 'write'] : ['read'] };
}

/**
 * Read the effective scope from a resolved principal. A key is `write` iff its
 * `api` actions include `'write'`; anything else (only `read`, empty, missing
 * resource, or `null` permissions) is `read` — least privilege by default.
 *
 * Accepts anything carrying `permissions` (the `ApiKeyPrincipal` shape) so it is
 * trivially unit-testable with a bare `{ permissions }` object.
 */
export function getApiKeyScope(principal: Pick<ApiKeyPrincipal, 'permissions'>): ApiScope {
	const actions = principal.permissions?.[API_SCOPE_RESOURCE] ?? [];
	return actions.includes(WRITE_ACTION) ? 'write' : 'read';
}

/** True when the principal's key carries the `write` scope. */
export function hasWriteScope(principal: Pick<ApiKeyPrincipal, 'permissions'>): boolean {
	return getApiKeyScope(principal) === 'write';
}

/**
 * The shared write-guard (PLAN §16.2). Every mutating endpoint calls this FIRST:
 *
 *     const denied = requireWriteScope(locals.apiKey);
 *     if (denied) return denied;   // 403 forbidden_scope — read key, no writes
 *
 * Returns the 403 `forbidden_scope` envelope `Response` when the key lacks the
 * `write` scope, or `null` when the write is permitted (so the handler proceeds).
 * Returning a `Response` (rather than throwing) keeps the guard explicit at the
 * call site and matches the project's `json()`-response idiom for the API.
 */
export function requireWriteScope(
	principal: Pick<ApiKeyPrincipal, 'permissions'>
): Response | null {
	return hasWriteScope(principal) ? null : forbiddenScope();
}
