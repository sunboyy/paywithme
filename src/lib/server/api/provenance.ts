// API-key audit provenance (PLAN §16.2, "Audit actor — zero schema change").
//
// The ONE adapter between the `/api/v1` principal and the audit writer's
// {@link AuditVia}. Every `/api/v1` mutating handler passes `auditVia(principal)`
// into the `lib/server` service it calls; the service hands it straight to
// `writeAuditLog`, which (in the SAME DB transaction as the mutation, §12.1)
// appends the "(via API key '<name>')" summary suffix and merges
// `{ viaKey, keyName }` into the existing nullable `metadata` jsonb.
//
// What this deliberately does NOT do:
//   - it does NOT change the actor. `audit_log.actorUserId` stays the USER id —
//     the key acts *as* its creating user and carries no independent authority.
//   - it does NOT need a schema change. A dedicated `actor_key_id` column is
//     rejected by §16.2; the provenance lives in `metadata` (indexable later via a
//     Postgres expression index on `metadata->>'viaKey'`).
//
// Web-session mutations never call this, so their audit rows carry no suffix and
// no provenance keys — that absence is how the two origins are distinguished.

import type { AuditVia } from '$lib/server/audit';
import type { ApiKeyPrincipal } from './principal';

/**
 * Project a resolved API-key principal into the audit-writer's provenance value.
 * Takes only the fields it needs, so a bare `{ keyId, name }` object works in
 * tests.
 */
export function auditVia(principal: Pick<ApiKeyPrincipal, 'keyId' | 'name'>): AuditVia {
	return { keyId: principal.keyId, keyName: principal.name };
}
