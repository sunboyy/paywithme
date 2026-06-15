import { describe, expect, it } from 'vitest';
import { displayNameSchema, registerSchema } from './auth';

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
