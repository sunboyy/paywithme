// Unit test for the API-key → audit-provenance adapter (PLAN §16.2, task #22).
//
// Tiny by design: the format lives in `audit.ts`; this module only projects the
// resolved principal onto the writer's `AuditVia`. What matters is that it carries
// the key ID + the (nullable) label and NOTHING that could be mistaken for
// authority — the actor is always the user, and this value never touches it.

import { describe, it, expect } from 'vitest';
import { auditVia } from './provenance';
import type { ApiKeyPrincipal } from './principal';

const principal: ApiKeyPrincipal = {
	keyId: 'key_abc',
	name: 'agent key',
	userId: 'user_1',
	permissions: { api: ['read', 'write'] }
};

describe('auditVia (PLAN §16.2) — the KEY origin', () => {
	it('projects the key id + label onto the audit writer’s `key` provenance shape', () => {
		expect(auditVia(principal)).toEqual({ kind: 'key', keyId: 'key_abc', keyName: 'agent key' });
	});

	it('passes an unnamed key’s null label through truthfully', () => {
		expect(auditVia({ ...principal, name: null })).toEqual({
			kind: 'key',
			keyId: 'key_abc',
			keyName: null
		});
	});

	it('carries NO user id / permissions — provenance is not authority', () => {
		expect(Object.keys(auditVia(principal)).sort()).toEqual(['keyId', 'keyName', 'kind']);
	});

	it('takes the key arm whenever `oauthClientId` is absent (api-key origin)', () => {
		// No `oauthClientId` on the principal → an api-key mutation, never mis-tagged as OAuth.
		expect(auditVia(principal).kind).toBe('key');
	});
});

// ── The OAUTH origin (ADR-0010 §Consequences; #42) ────────────────────────────
// An OAuth-resolved principal carries `oauthClientId` (the raw connected-app id);
// its PRESENCE selects the `oauth` arm, so a `/mcp` OAuth mutation is tagged
// `viaOAuth`, NOT mis-tagged as a `viaKey` built from the composed `keyId`.
describe('auditVia (ADR-0010 §Consequences) — the OAUTH origin', () => {
	// The composed OAuth principal exactly as `resolveOAuthPrincipal` builds it:
	// `keyId = ${clientId}:${userId}`, `name = null`, plus the raw `oauthClientId`.
	const oauthPrincipal: ApiKeyPrincipal = {
		keyId: 'client_1:user_oauth',
		name: null,
		userId: 'user_oauth',
		permissions: { api: ['read', 'write'] },
		oauthClientId: 'client_1'
	};

	it('projects the RAW client id onto the `oauth` provenance shape', () => {
		// The actor tag is the bare client id — NOT the composed `keyId` and NOT `keyName`.
		expect(auditVia(oauthPrincipal)).toEqual({ kind: 'oauth', clientId: 'client_1' });
	});

	it('does NOT leak the composed keyId or a keyName — the OAuth tag is client-id only', () => {
		expect(Object.keys(auditVia(oauthPrincipal)).sort()).toEqual(['clientId', 'kind']);
	});
});
