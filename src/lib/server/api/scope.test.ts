// Unit tests for the API-key scope model + write-guard (§16.2).
//
// Assert the encoding convention (`{ api: [...] }`), the least-privilege scope
// reader, and that `requireWriteScope` returns a 403 `forbidden_scope` envelope
// for a read key and passes a write key.

import { describe, it, expect } from 'vitest';
import {
	API_SCOPE_RESOURCE,
	scopeToPermissions,
	getApiKeyScope,
	hasWriteScope,
	requireWriteScope
} from './scope';

describe('scopeToPermissions — encoding convention', () => {
	it('encodes read as { api: ["read"] }', () => {
		expect(scopeToPermissions('read')).toEqual({ [API_SCOPE_RESOURCE]: ['read'] });
	});

	it('encodes write as { api: ["read", "write"] } (write ⊇ read)', () => {
		expect(scopeToPermissions('write')).toEqual({ [API_SCOPE_RESOURCE]: ['read', 'write'] });
	});

	it('round-trips through getApiKeyScope', () => {
		expect(getApiKeyScope({ permissions: scopeToPermissions('read') })).toBe('read');
		expect(getApiKeyScope({ permissions: scopeToPermissions('write') })).toBe('write');
	});
});

describe('getApiKeyScope — least privilege by default', () => {
	it('is write when the api actions include "write"', () => {
		expect(getApiKeyScope({ permissions: { api: ['read', 'write'] } })).toBe('write');
		// Order-independent, and a lone "write" still reads as write.
		expect(getApiKeyScope({ permissions: { api: ['write'] } })).toBe('write');
	});

	it('is read when only "read" is present', () => {
		expect(getApiKeyScope({ permissions: { api: ['read'] } })).toBe('read');
	});

	it('defaults to read for null / missing / empty permissions', () => {
		expect(getApiKeyScope({ permissions: null })).toBe('read');
		expect(getApiKeyScope({ permissions: {} })).toBe('read');
		expect(getApiKeyScope({ permissions: { api: [] } })).toBe('read');
		// An unrelated resource key never grants write.
		expect(getApiKeyScope({ permissions: { other: ['write'] } })).toBe('read');
	});
});

describe('hasWriteScope', () => {
	it('mirrors getApiKeyScope === "write"', () => {
		expect(hasWriteScope({ permissions: { api: ['read', 'write'] } })).toBe(true);
		expect(hasWriteScope({ permissions: { api: ['read'] } })).toBe(false);
		expect(hasWriteScope({ permissions: null })).toBe(false);
	});
});

describe('requireWriteScope — the shared write-guard', () => {
	it('returns a 403 forbidden_scope envelope for a read key', async () => {
		const denied = requireWriteScope({ permissions: { api: ['read'] } });
		expect(denied).not.toBeNull();
		expect(denied!.status).toBe(403);
		expect(denied!.headers.get('content-type')).toContain('application/json');
		expect(await denied!.json()).toEqual({
			error: { code: 'forbidden_scope', message: expect.any(String) }
		});
	});

	it('returns a 403 for null / missing permissions (least privilege)', () => {
		expect(requireWriteScope({ permissions: null })).not.toBeNull();
		expect(requireWriteScope({ permissions: {} })).not.toBeNull();
	});

	it('returns null (allows the write) for a write key', () => {
		expect(requireWriteScope({ permissions: { api: ['read', 'write'] } })).toBeNull();
	});
});
