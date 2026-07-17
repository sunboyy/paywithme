import { describe, it, expect } from 'vitest';
import { isOriginAllowed, parseAllowedOrigins } from './origin';

const SELF = 'https://paywithme.example.com';

describe('parseAllowedOrigins', () => {
	it('splits, trims and normalizes a comma-separated list', () => {
		expect(parseAllowedOrigins(' https://a.example.com/ , https://B.example.com ')).toEqual([
			'https://a.example.com',
			'https://b.example.com'
		]);
	});

	it('returns an empty list for unset / empty config', () => {
		expect(parseAllowedOrigins(undefined)).toEqual([]);
		expect(parseAllowedOrigins(null)).toEqual([]);
		expect(parseAllowedOrigins('')).toEqual([]);
		expect(parseAllowedOrigins('  ,  ')).toEqual([]);
	});

	it('drops an unparseable entry rather than crashing — a config typo fails CLOSED', () => {
		expect(parseAllowedOrigins('not-a-url, https://ok.example.com')).toEqual([
			'https://ok.example.com'
		]);
	});
});

describe('isOriginAllowed (the DNS-rebinding defence — ADR-0001)', () => {
	it('allows an ABSENT Origin — Claude Code / Cursor are not browsers and send none', () => {
		expect(isOriginAllowed(null, SELF)).toBe(true);
		expect(isOriginAllowed(undefined, SELF)).toBe(true);
		expect(isOriginAllowed('  ', SELF)).toBe(true);
	});

	it('allows the app’s own origin', () => {
		expect(isOriginAllowed(SELF, SELF)).toBe(true);
		// Normalized: a trailing slash / different case is still the same origin.
		expect(isOriginAllowed('https://PayWithMe.example.com/', SELF)).toBe(true);
	});

	it('DENIES a foreign origin — the rebinding attack', () => {
		expect(isOriginAllowed('https://evil.example', SELF)).toBe(false);
		// A different scheme or port is a DIFFERENT origin.
		expect(isOriginAllowed('http://paywithme.example.com', SELF)).toBe(false);
		expect(isOriginAllowed('https://paywithme.example.com:8443', SELF)).toBe(false);
	});

	it('DENIES the literal `null` origin (an opaque/sandboxed browser context)', () => {
		expect(isOriginAllowed('null', SELF)).toBe(false);
	});

	it('allows an explicitly configured extra origin', () => {
		const allowed = parseAllowedOrigins('https://claude.ai');
		expect(isOriginAllowed('https://claude.ai', SELF, allowed)).toBe(true);
		expect(isOriginAllowed('https://evil.example', SELF, allowed)).toBe(false);
	});
});
