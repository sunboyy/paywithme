import { describe, expect, it } from 'vitest';
import { emptyStateKind, hasActiveFilter } from './empty-state';

// Unit tests for the pure empty-state branching helper (task 8.1). The three
// states a filterable list can be in are exactly the screens' decision: show the
// list, show "filter matched nothing", or show "nothing exists yet".

describe('emptyStateKind', () => {
	it('is populated when there are rows, regardless of filter', () => {
		expect(emptyStateKind(1, false)).toBe('populated');
		expect(emptyStateKind(5, true)).toBe('populated');
	});

	it('is nothing-yet when empty and NO filter is active', () => {
		expect(emptyStateKind(0, false)).toBe('nothing-yet');
	});

	it('is filtered-empty when empty and a filter IS active', () => {
		expect(emptyStateKind(0, true)).toBe('filtered-empty');
	});
});

describe('hasActiveFilter', () => {
	it('is false when every filter value is null/undefined/empty', () => {
		expect(hasActiveFilter(null, undefined, '')).toBe(false);
		expect(hasActiveFilter()).toBe(false);
	});

	it('is true when any filter value is a non-empty string', () => {
		expect(hasActiveFilter(null, 'spending')).toBe(true);
		expect(hasActiveFilter('food', null)).toBe(true);
	});
});
