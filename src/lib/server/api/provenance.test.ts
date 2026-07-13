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

describe('auditVia (PLAN §16.2)', () => {
	it('projects the key id + label onto the audit writer’s provenance shape', () => {
		expect(auditVia(principal)).toEqual({ keyId: 'key_abc', keyName: 'agent key' });
	});

	it('passes an unnamed key’s null label through truthfully', () => {
		expect(auditVia({ ...principal, name: null })).toEqual({ keyId: 'key_abc', keyName: null });
	});

	it('carries NO user id / permissions — provenance is not authority', () => {
		expect(Object.keys(auditVia(principal)).sort()).toEqual(['keyId', 'keyName']);
	});
});
