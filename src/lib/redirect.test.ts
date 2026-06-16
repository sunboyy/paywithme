import { describe, expect, it } from 'vitest';
import { safeRedirectTo } from './redirect';

// Unit tests for the SAFE post-auth redirect sanitizer (task 3.7, PLAN §6.2/§12).
// `redirectTo` is attacker-controlled, so the helper is the only gate between a
// URL param and a `redirect(303, …)` / client `goto(…)`. It must accept ONLY
// same-origin local paths and reject every open-redirect / scheme vector.

describe('safeRedirectTo', () => {
	it('accepts plain local paths', () => {
		expect(safeRedirectTo('/groups')).toBe('/groups');
		expect(safeRedirectTo('/invite/abc')).toBe('/invite/abc');
		// Query strings / nested paths are fine — still same-origin.
		expect(safeRedirectTo('/login?redirectTo=/x')).toBe('/login?redirectTo=/x');
	});

	it('rejects protocol-relative URLs (open redirect)', () => {
		expect(safeRedirectTo('//evil.com')).toBeNull();
		expect(safeRedirectTo('//evil.com/path')).toBeNull();
	});

	it('rejects the backslash protocol-relative trick', () => {
		// Browsers normalize `/\` like `//` → off-origin navigation.
		expect(safeRedirectTo('/\\evil')).toBeNull();
	});

	it('rejects absolute URLs with a scheme', () => {
		expect(safeRedirectTo('https://x')).toBeNull();
		expect(safeRedirectTo('http://evil.com')).toBeNull();
	});

	it('rejects the javascript: scheme', () => {
		expect(safeRedirectTo('javascript:alert(1)')).toBeNull();
	});

	it('rejects the empty string', () => {
		expect(safeRedirectTo('')).toBeNull();
	});

	it('rejects non-string input (defensive — param is string | null)', () => {
		expect(safeRedirectTo(null)).toBeNull();
		expect(safeRedirectTo(undefined)).toBeNull();
		expect(safeRedirectTo(42)).toBeNull();
		expect(safeRedirectTo({})).toBeNull();
	});

	it('rejects bare/relative values not starting with /', () => {
		expect(safeRedirectTo('groups')).toBeNull();
		expect(safeRedirectTo('mailto:a@b.com')).toBeNull();
	});
});
