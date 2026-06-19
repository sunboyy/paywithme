// Pure helper for the empty-state branching shared by filterable list screens
// (task 8.1; PLAN §14.8). A screen with filters has THREE states, not two:
//   - populated            → render the list
//   - filtered-empty        → "no matches for this filter" + clear-filter CTA
//   - nothing-yet (no filter active, still empty) → "nothing here" + create CTA
//
// Keeping this as a tiny pure function lets the non-trivial branching be unit
// tested directly, instead of via brittle full-page renders. The transactions
// and activity feeds both decide their empty copy from this.

/** Which empty state (if any) a filterable list should show. */
export type EmptyStateKind = 'populated' | 'filtered-empty' | 'nothing-yet';

/**
 * Decide the empty-state kind for a filterable collection.
 *
 * @param count          number of rows the `load` returned (post-filter)
 * @param filterActive   whether ANY filter is currently applied
 */
export function emptyStateKind(count: number, filterActive: boolean): EmptyStateKind {
	if (count > 0) return 'populated';
	return filterActive ? 'filtered-empty' : 'nothing-yet';
}

/** Convenience: is there an active filter, given a set of filter values? */
export function hasActiveFilter(...values: Array<string | null | undefined>): boolean {
	return values.some((v) => v != null && v !== '');
}
