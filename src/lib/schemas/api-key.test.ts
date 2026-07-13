import { describe, it, expect } from 'vitest';
import {
	createApiKeySchema,
	revokeApiKeySchema,
	API_KEY_CUSTOM_EXPIRY_MAX_DAYS,
	API_KEY_NAME_MAX_LENGTH
} from './api-key';

// Unit tests for the API-key form schemas (PLAN §16.8).
//
// These guard the INPUT boundary of the create/revoke flows: the defaults the
// plan pins down (read scope, never-expires), the cross-field custom-expiry rule,
// and the bounds that keep the better-auth plugin from 400ing on us.

/** Parse the way a no-JS form submission arrives: everything is a string. */
function parseForm(fields: Record<string, string>) {
	return createApiKeySchema.safeParse(fields);
}

describe('createApiKeySchema', () => {
	it('defaults to the LEAST-PRIVILEGE, non-expiring key (PLAN §16.2/§16.8)', () => {
		// Neither field submitted → the key that gets minted must be the one that
		// cannot move money, and must not silently acquire a TTL.
		const result = createApiKeySchema.safeParse({ name: 'My agent' });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.scope).toBe('read');
			expect(result.data.expiry).toBe('never');
			expect(result.data.customDays).toBeUndefined();
		}
	});

	it('accepts the write scope and each expiry preset', () => {
		for (const expiry of ['never', '30', '90', '365'] as const) {
			const result = parseForm({ name: 'k', scope: 'write', expiry });
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.scope).toBe('write');
				expect(result.data.expiry).toBe(expiry);
			}
		}
	});

	it('rejects an unknown scope rather than silently downgrading it', () => {
		// A junk scope must be a hard validation error — never quietly coerced to
		// `write` (privilege escalation) NOR to `read` (a silently wrong key).
		expect(parseForm({ name: 'k', scope: 'admin', expiry: 'never' }).success).toBe(false);
	});

	it('rejects an unknown expiry choice', () => {
		expect(parseForm({ name: 'k', scope: 'read', expiry: '7' }).success).toBe(false);
	});

	it('requires a name, trims it, and caps it at the plugin length limit', () => {
		expect(parseForm({ name: '', scope: 'read', expiry: 'never' }).success).toBe(false);
		expect(parseForm({ name: '   ', scope: 'read', expiry: 'never' }).success).toBe(false);

		const trimmed = parseForm({ name: '  Budget bot  ', scope: 'read', expiry: 'never' });
		expect(trimmed.success).toBe(true);
		if (trimmed.success) expect(trimmed.data.name).toBe('Budget bot');

		const tooLong = parseForm({
			name: 'x'.repeat(API_KEY_NAME_MAX_LENGTH + 1),
			scope: 'read',
			expiry: 'never'
		});
		expect(tooLong.success).toBe(false);
	});

	describe('custom expiry (the cross-field rule)', () => {
		it('requires customDays when "custom" is chosen, with the error on that field', () => {
			const result = parseForm({ name: 'k', scope: 'read', expiry: 'custom' });
			expect(result.success).toBe(false);
			if (!result.success) {
				const issue = result.error.issues.find((i) => i.path[0] === 'customDays');
				// Attached to the field so it renders next to the input, not as a
				// form-level message.
				expect(issue).toBeDefined();
			}
		});

		it('coerces the string a no-JS form sends into a number', () => {
			const result = parseForm({ name: 'k', scope: 'read', expiry: 'custom', customDays: '14' });
			expect(result.success).toBe(true);
			if (result.success) expect(result.data.customDays).toBe(14);
		});

		it('rejects zero, negative, fractional, and over-max day counts', () => {
			for (const customDays of [
				'0',
				'-5',
				'1.5',
				String(API_KEY_CUSTOM_EXPIRY_MAX_DAYS + 1),
				'abc'
			]) {
				const result = parseForm({ name: 'k', scope: 'read', expiry: 'custom', customDays });
				expect(result.success, `customDays=${customDays} should be rejected`).toBe(false);
			}
		});

		it('accepts the boundary values 1 and 365 (the plugin’s own bounds)', () => {
			for (const customDays of ['1', String(API_KEY_CUSTOM_EXPIRY_MAX_DAYS)]) {
				expect(parseForm({ name: 'k', scope: 'read', expiry: 'custom', customDays }).success).toBe(
					true
				);
			}
		});

		it('ignores a stale customDays when another expiry choice is selected', () => {
			// The browser can leave a value in the always-rendered custom input. It
			// must not make a "never" key expire — the schema still parses, and the
			// service reads the CHOICE, not this field (see expiresInSeconds).
			const result = parseForm({ name: 'k', scope: 'read', expiry: 'never', customDays: '30' });
			expect(result.success).toBe(true);
		});
	});
});

describe('revokeApiKeySchema', () => {
	it('requires a non-empty id', () => {
		expect(revokeApiKeySchema.safeParse({ id: 'key_1' }).success).toBe(true);
		expect(revokeApiKeySchema.safeParse({ id: '' }).success).toBe(false);
		expect(revokeApiKeySchema.safeParse({}).success).toBe(false);
	});
});
