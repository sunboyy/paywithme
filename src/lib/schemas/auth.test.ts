import { describe, expect, it } from 'vitest';
import { deletePasskeySchema, displayNameSchema, loginSchema, registerSchema } from './auth';

describe('registerSchema', () => {
	it('accepts valid input and normalizes email (trim + lowercase) and name (trim)', () => {
		const result = registerSchema.safeParse({
			email: '  ALICE@Example.COM ',
			name: '  Alice Smith  '
		});

		expect(result.success).toBe(true);
		// Normalized output is what downstream (the magic-link send) consumes.
		expect(result.data).toEqual({ email: 'alice@example.com', name: 'Alice Smith' });
	});

	it('rejects a missing email', () => {
		const result = registerSchema.safeParse({ name: 'Alice' });
		expect(result.success).toBe(false);
	});

	it('rejects an empty email', () => {
		const result = registerSchema.safeParse({ email: '', name: 'Alice' });
		expect(result.success).toBe(false);
	});

	it('rejects an invalid email', () => {
		const result = registerSchema.safeParse({ email: 'not-an-email', name: 'Alice' });
		expect(result.success).toBe(false);
		expect(result.error?.issues.some((i) => i.path[0] === 'email')).toBe(true);
	});

	it('rejects a whitespace-only email', () => {
		const result = registerSchema.safeParse({ email: '   ', name: 'Alice' });
		expect(result.success).toBe(false);
	});

	it('rejects an empty display name', () => {
		const result = registerSchema.safeParse({ email: 'a@b.com', name: '' });
		expect(result.success).toBe(false);
		expect(result.error?.issues.some((i) => i.path[0] === 'name')).toBe(true);
	});

	it('rejects a whitespace-only display name (trimmed to empty)', () => {
		const result = registerSchema.safeParse({ email: 'a@b.com', name: '    ' });
		expect(result.success).toBe(false);
		expect(result.error?.issues.some((i) => i.path[0] === 'name')).toBe(true);
	});

	it('rejects a display name longer than 100 characters', () => {
		const result = registerSchema.safeParse({ email: 'a@b.com', name: 'x'.repeat(101) });
		expect(result.success).toBe(false);
		expect(result.error?.issues.some((i) => i.path[0] === 'name')).toBe(true);
	});

	it('accepts a display name of exactly 100 characters', () => {
		const result = registerSchema.safeParse({ email: 'a@b.com', name: 'x'.repeat(100) });
		expect(result.success).toBe(true);
	});
});

describe('displayNameSchema', () => {
	// `displayNameSchema.name` shares its rule (`nameField`) with
	// `registerSchema.name`, so these assert that the post-verify capture form
	// (PLAN §5.3, #26) enforces the same trim / empty / length behaviour.

	it('accepts a valid name and trims it', () => {
		const result = displayNameSchema.safeParse({ name: '  Alice Smith  ' });
		expect(result.success).toBe(true);
		expect(result.data).toEqual({ name: 'Alice Smith' });
	});

	it('rejects a missing name', () => {
		const result = displayNameSchema.safeParse({});
		expect(result.success).toBe(false);
		expect(result.error?.issues.some((i) => i.path[0] === 'name')).toBe(true);
	});

	it('rejects an empty name', () => {
		const result = displayNameSchema.safeParse({ name: '' });
		expect(result.success).toBe(false);
		expect(result.error?.issues.some((i) => i.path[0] === 'name')).toBe(true);
	});

	it('rejects a whitespace-only name (trimmed to empty)', () => {
		const result = displayNameSchema.safeParse({ name: '   ' });
		expect(result.success).toBe(false);
		expect(result.error?.issues.some((i) => i.path[0] === 'name')).toBe(true);
	});

	it('rejects a name longer than 100 characters', () => {
		const result = displayNameSchema.safeParse({ name: 'x'.repeat(101) });
		expect(result.success).toBe(false);
		expect(result.error?.issues.some((i) => i.path[0] === 'name')).toBe(true);
	});

	it('accepts a name of exactly 100 characters', () => {
		const result = displayNameSchema.safeParse({ name: 'x'.repeat(100) });
		expect(result.success).toBe(true);
	});

	it('shares the same name messages as registerSchema (no drift)', () => {
		const empty = { name: '' };
		const fromRegister = registerSchema.safeParse({ email: 'a@b.com', ...empty });
		const fromDisplayName = displayNameSchema.safeParse(empty);

		const registerMsg = fromRegister.error?.issues.find((i) => i.path[0] === 'name')?.message;
		const displayNameMsg = fromDisplayName.error?.issues.find((i) => i.path[0] === 'name')?.message;

		expect(displayNameMsg).toBe(registerMsg);
		expect(displayNameMsg).toBe('Display name is required');
	});
});

describe('loginSchema', () => {
	// `loginSchema.email` shares its rule (`emailField`) with
	// `registerSchema.email`. Login is email-only (no display name — PLAN §5.5).

	it('accepts a valid email and normalizes it (trim + lowercase)', () => {
		const result = loginSchema.safeParse({ email: '  ALICE@Example.COM ' });
		expect(result.success).toBe(true);
		expect(result.data).toEqual({ email: 'alice@example.com' });
	});

	it('does not require (or accept extra) a display name', () => {
		// Login is email-only: a name is neither required nor part of the output.
		const result = loginSchema.safeParse({ email: 'a@b.com' });
		expect(result.success).toBe(true);
		expect(result.data).toEqual({ email: 'a@b.com' });
		expect(result.data).not.toHaveProperty('name');
	});

	it('rejects a missing email', () => {
		const result = loginSchema.safeParse({});
		expect(result.success).toBe(false);
		expect(result.error?.issues.some((i) => i.path[0] === 'email')).toBe(true);
	});

	it('rejects an empty email', () => {
		const result = loginSchema.safeParse({ email: '' });
		expect(result.success).toBe(false);
		expect(result.error?.issues.some((i) => i.path[0] === 'email')).toBe(true);
	});

	it('rejects an invalid email', () => {
		const result = loginSchema.safeParse({ email: 'not-an-email' });
		expect(result.success).toBe(false);
		expect(result.error?.issues.some((i) => i.path[0] === 'email')).toBe(true);
	});

	it('rejects a whitespace-only email (trimmed to empty)', () => {
		const result = loginSchema.safeParse({ email: '   ' });
		expect(result.success).toBe(false);
		expect(result.error?.issues.some((i) => i.path[0] === 'email')).toBe(true);
	});

	it('shares the same email messages as registerSchema (no drift)', () => {
		const bad = { email: 'not-an-email' };
		const fromLogin = loginSchema.safeParse(bad);
		const fromRegister = registerSchema.safeParse({ ...bad, name: 'Alice' });

		const loginMsg = fromLogin.error?.issues.find((i) => i.path[0] === 'email')?.message;
		const registerMsg = fromRegister.error?.issues.find((i) => i.path[0] === 'email')?.message;

		expect(loginMsg).toBe(registerMsg);
		expect(loginMsg).toBe('Enter a valid email address');
	});
});

describe('deletePasskeySchema', () => {
	// Backs the `/settings` `?/delete` action (PLAN §5.4): a single required,
	// non-empty `id` string identifying the passkey row to remove.

	it('accepts a non-empty id', () => {
		const result = deletePasskeySchema.safeParse({ id: 'pk_abc123' });
		expect(result.success).toBe(true);
		expect(result.data).toEqual({ id: 'pk_abc123' });
	});

	it('rejects a missing id', () => {
		const result = deletePasskeySchema.safeParse({});
		expect(result.success).toBe(false);
		expect(result.error?.issues.some((i) => i.path[0] === 'id')).toBe(true);
	});

	it('rejects an empty id', () => {
		const result = deletePasskeySchema.safeParse({ id: '' });
		expect(result.success).toBe(false);
		expect(result.error?.issues.some((i) => i.path[0] === 'id')).toBe(true);
	});

	it('rejects a non-string id', () => {
		const result = deletePasskeySchema.safeParse({ id: 123 });
		expect(result.success).toBe(false);
		expect(result.error?.issues.some((i) => i.path[0] === 'id')).toBe(true);
	});
});
