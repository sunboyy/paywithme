import { describe, it, expect } from 'vitest';
import { isUniqueViolation } from './pg-errors';

describe('isUniqueViolation', () => {
	it('is true for a bare pg error carrying 23505', () => {
		expect(isUniqueViolation(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBe(
			true
		);
	});

	it('is true when 23505 is on the cause — the shape Drizzle actually throws', () => {
		// A `DrizzleQueryError` has its own `code` undefined and wraps the `pg` error
		// (which carries `23505`) in `cause`. This is the case the old own-`code`-only
		// checks in invites.ts / idempotency.ts missed against real Postgres.
		const pgError = Object.assign(new Error('duplicate key value'), { code: '23505' });
		const wrapped = Object.assign(new Error('Failed query'), { cause: pgError });
		expect(isUniqueViolation(wrapped)).toBe(true);
	});

	it('is true when 23505 sits deeper in the cause chain', () => {
		const pgError = Object.assign(new Error('duplicate key value'), { code: '23505' });
		const mid = Object.assign(new Error('mid'), { cause: pgError });
		const top = Object.assign(new Error('top'), { cause: mid });
		expect(isUniqueViolation(top)).toBe(true);
	});

	it('is false for a different SQLSTATE, wrapped or not', () => {
		const pgError = Object.assign(new Error('not null violation'), { code: '23502' });
		expect(isUniqueViolation(pgError)).toBe(false);
		expect(isUniqueViolation(Object.assign(new Error('Failed query'), { cause: pgError }))).toBe(
			false
		);
	});

	it('is false for non-error inputs', () => {
		expect(isUniqueViolation(null)).toBe(false);
		expect(isUniqueViolation(undefined)).toBe(false);
		expect(isUniqueViolation('23505')).toBe(false);
		expect(isUniqueViolation({})).toBe(false);
	});

	it('does not loop forever on a cyclic cause chain', () => {
		const a: { cause?: unknown; code?: string } = { code: 'XXXXX' };
		const b: { cause?: unknown } = { cause: a };
		a.cause = b;
		expect(isUniqueViolation(a)).toBe(false);
	});
});
