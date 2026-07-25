// Pure helpers for grouping a dated list into day sections.
//
// The transactions list previously stamped every row with its own absolute date
// ("Jul 25, 2026"), so a day's worth of spending repeated the same string on
// every line — a whole subtitle line per row carrying no distinguishing
// information. Grouping under one day heading says it once and gives the row
// back to the title.
//
// Kept as pure functions (like `empty-state.ts` / `activity-labels.ts`) so the
// non-trivial bits — local-calendar-day bucketing and the relative day label —
// are unit tested directly rather than through brittle full-page renders.

/** A run of consecutive items that fall on the same local calendar day. */
export interface DayGroup<T> {
	/** Stable `YYYY-MM-DD` key for the local day — safe as an `{#each}` key. */
	readonly key: string;
	/** Human heading: "Today" / "Yesterday" / "Jul 25" / "Jul 25, 2025". */
	readonly label: string;
	/** The items in this day, in the order they arrived. */
	readonly items: readonly T[];
}

/**
 * Local calendar day of `iso` as `YYYY-MM-DD`.
 *
 * Uses local getters (NOT `toISOString()`, which is UTC) so a late-evening
 * transaction groups under the day the user actually experienced it.
 */
export function dayKey(value: string | Date): string {
	const d = value instanceof Date ? value : new Date(value);
	const year = d.getFullYear();
	const month = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

/**
 * Heading for a day: "Today" / "Yesterday" for the two most recent days,
 * otherwise a month-day date — with the year appended only when it differs from
 * the current one (a 2025 row in 2026 needs the year; a 2026 row does not).
 */
export function dayLabel(iso: string, now: Date = new Date()): string {
	const d = new Date(iso);
	const subject = dayKey(d);

	if (subject === dayKey(now)) return 'Today';

	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	if (subject === dayKey(yesterday)) return 'Yesterday';

	const sameYear = d.getFullYear() === now.getFullYear();
	return d.toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		...(sameYear ? {} : { year: 'numeric' })
	});
}

/**
 * Bucket an ALREADY-SORTED list into consecutive day groups.
 *
 * Consecutive-run grouping (not a global map) so the caller's ordering is
 * preserved exactly: the list arrives newest-first from the server and stays
 * that way. A day that somehow appears twice non-consecutively yields two
 * groups rather than silently reordering the rows.
 */
export function groupByDay<T>(
	items: readonly T[],
	getIso: (item: T) => string,
	now: Date = new Date()
): DayGroup<T>[] {
	const groups: DayGroup<T>[] = [];
	let current: { key: string; label: string; items: T[] } | undefined;

	for (const item of items) {
		const iso = getIso(item);
		const key = dayKey(iso);
		if (current === undefined || current.key !== key) {
			current = { key, label: dayLabel(iso, now), items: [] };
			groups.push(current);
		}
		current.items.push(item);
	}

	return groups;
}
