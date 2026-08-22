import { describe, it, expect } from 'vitest';
import { normalizeDisplayName, displayNameValues } from './member-name';

// The canonical form of a member display name (ADR-0015; issue #75). These cases are
// the contract the `members_group_id_normalized_display_name_unique` index enforces:
// every pair that normalizes to the same string is a pair the database will refuse
// among active members of one group, and every pair that does not is a pair it
// allows. The real-DB proof that Postgres agrees lives in
// `tests/integration/member-name-uniqueness.test.ts`.

describe('normalizeDisplayName', () => {
	it('lowercases', () => {
		expect(normalizeDisplayName('Nan')).toBe('nan');
		expect(normalizeDisplayName('NAN')).toBe('nan');
	});

	it('trims leading and trailing whitespace of every kind', () => {
		expect(normalizeDisplayName('  Nan  ')).toBe('nan');
		expect(normalizeDisplayName('\tNan\n')).toBe('nan');
		// A non-breaking space is whitespace to `String.prototype.trim` too, so a name
		// pasted from a rich-text source folds onto the plain one.
		expect(normalizeDisplayName('\u00a0Nan\u00a0')).toBe('nan');
	});

	it('composes to NFC, so decomposed and precomposed forms share one key', () => {
		// 'é' as one code point vs 'e' + COMBINING ACUTE ACCENT: visually identical,
		// different bytes, and only NFC makes them compare equal.
		const precomposed = 'Ren\u00e9';
		const decomposed = 'Rene\u0301';
		expect(precomposed).not.toBe(decomposed);
		expect(normalizeDisplayName(precomposed)).toBe(normalizeDisplayName(decomposed));
		expect(normalizeDisplayName(decomposed)).toBe('ren\u00e9');
	});

	it('normalizes Thai text without mangling it (the app is Thai-facing)', () => {
		expect(normalizeDisplayName('  สุรวิชญ์  ')).toBe('สุรวิชญ์');
	});

	it('compares the FULL name, not the first-token prefix rule in similar-names.ts', () => {
		// The uniqueness constraint is an EQUALITY test. `Nan` and `Nan Suphaporn` are
		// two different members and must stay that way (ADR-0015 "What this does not
		// fix"); only the post-write similarity HINT relates them.
		expect(normalizeDisplayName('Nan')).not.toBe(normalizeDisplayName('Nan Suphaporn'));
		expect(normalizeDisplayName('Nan')).not.toBe(normalizeDisplayName('Nanthawat P.'));
	});

	it('preserves internal whitespace exactly (no squeezing)', () => {
		// Deliberate: folding runs of inner spaces is extra policy the constraint does
		// not claim, so `Nan  Suphaporn` and `Nan Suphaporn` remain distinct keys.
		expect(normalizeDisplayName('Nan  Suphaporn')).toBe('nan  suphaporn');
		expect(normalizeDisplayName('Nan  Suphaporn')).not.toBe(normalizeDisplayName('Nan Suphaporn'));
	});

	it('does not fold accents, case-insensitive-looking punctuation, or anything else', () => {
		expect(normalizeDisplayName('René')).not.toBe(normalizeDisplayName('Rene'));
		expect(normalizeDisplayName('Nan.')).not.toBe(normalizeDisplayName('Nan'));
	});

	it('is idempotent — normalizing a key again returns the same key', () => {
		const once = normalizeDisplayName('  RENÉ  ');
		expect(normalizeDisplayName(once)).toBe(once);
	});

	it('yields the empty string for a blank name rather than throwing', () => {
		// Unreachable in production (`memberDisplayNameField` requires a non-blank name
		// at the boundary), but the function must be total.
		expect(normalizeDisplayName('')).toBe('');
		expect(normalizeDisplayName('   ')).toBe('');
	});
});

describe('displayNameValues', () => {
	it('returns the name VERBATIM alongside its key', () => {
		// The display form belongs to the user; only the derived key is folded.
		expect(displayNameValues('Nan Suphaporn')).toEqual({
			displayName: 'Nan Suphaporn',
			normalizedDisplayName: 'nan suphaporn'
		});
	});

	it('does not trim the stored display name — the schema already did', () => {
		// `memberDisplayNameField` trims at the boundary, so a padded name reaching
		// here would be a bug upstream; this helper must not paper over it by quietly
		// rewriting what gets stored.
		expect(displayNameValues('  Nan  ')).toEqual({
			displayName: '  Nan  ',
			normalizedDisplayName: 'nan'
		});
	});

	it('carries exactly the two name columns, so it is safe to spread into values()', () => {
		expect(Object.keys(displayNameValues('Nan')).sort()).toEqual([
			'displayName',
			'normalizedDisplayName'
		]);
	});
});
