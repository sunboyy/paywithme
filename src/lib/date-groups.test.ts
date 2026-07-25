import { describe, expect, it } from 'vitest';
import { dayKey, dayLabel, groupByDay } from './date-groups';

// A fixed "now" so the relative labels ("Today"/"Yesterday") are deterministic.
// Built from LOCAL components so the assertions hold in any TZ the suite runs in
// — constructing from a UTC string would drift a day either side of the date line.
const NOW = new Date(2026, 6, 25, 14, 30); // 25 Jul 2026, 14:30 local

/** Local ISO string for a given local date/time — mirrors what the DB hands back. */
function localIso(y: number, m: number, d: number, h = 12, min = 0): string {
	return new Date(y, m, d, h, min).toISOString();
}

describe('dayKey', () => {
	it('returns the LOCAL calendar day as YYYY-MM-DD', () => {
		expect(dayKey(new Date(2026, 6, 25, 14, 30))).toBe('2026-07-25');
		expect(dayKey(new Date(2026, 0, 5, 9, 0))).toBe('2026-01-05');
	});

	it('zero-pads month and day', () => {
		expect(dayKey(new Date(2026, 8, 3))).toBe('2026-09-03');
	});

	it('buckets a late-evening time under the local day, not the UTC day', () => {
		// 23:30 local on the 25th is the 26th in UTC for any negative-offset zone.
		// Grouping must follow the day the user actually experienced.
		expect(dayKey(new Date(2026, 6, 25, 23, 30))).toBe('2026-07-25');
	});

	it('accepts an ISO string as well as a Date', () => {
		const d = new Date(2026, 6, 25, 14, 30);
		expect(dayKey(d.toISOString())).toBe(dayKey(d));
	});
});

describe('dayLabel', () => {
	it('labels the current day "Today"', () => {
		expect(dayLabel(localIso(2026, 6, 25, 9), NOW)).toBe('Today');
		// Same day, different time of day — still Today.
		expect(dayLabel(localIso(2026, 6, 25, 23), NOW)).toBe('Today');
	});

	it('labels the previous day "Yesterday"', () => {
		expect(dayLabel(localIso(2026, 6, 24, 20), NOW)).toBe('Yesterday');
	});

	it('crosses a month boundary correctly for "Yesterday"', () => {
		const firstOfMonth = new Date(2026, 7, 1, 10, 0); // 1 Aug 2026
		expect(dayLabel(localIso(2026, 6, 31, 18), firstOfMonth)).toBe('Yesterday');
	});

	it('omits the year for other days in the current year', () => {
		const label = dayLabel(localIso(2026, 2, 14), NOW);
		expect(label).toContain('14');
		expect(label).not.toContain('2026');
	});

	it('includes the year for days in a different year', () => {
		expect(dayLabel(localIso(2025, 11, 31), NOW)).toContain('2025');
	});
});

describe('groupByDay', () => {
	const item = (iso: string, id: string) => ({ id, createdAt: iso });

	it('collapses a run of same-day items into one group', () => {
		const items = [
			item(localIso(2026, 6, 25, 20), 'a'),
			item(localIso(2026, 6, 25, 13), 'b'),
			item(localIso(2026, 6, 25, 9), 'c')
		];
		const groups = groupByDay(items, (i) => i.createdAt, NOW);

		expect(groups).toHaveLength(1);
		expect(groups[0].label).toBe('Today');
		expect(groups[0].items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
	});

	it('splits across day boundaries and preserves the incoming order', () => {
		const items = [
			item(localIso(2026, 6, 25, 20), 'a'),
			item(localIso(2026, 6, 24, 20), 'b'),
			item(localIso(2026, 6, 24, 8), 'c'),
			item(localIso(2026, 6, 20, 8), 'd')
		];
		const groups = groupByDay(items, (i) => i.createdAt, NOW);

		expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', groups[2].label]);
		expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([['a'], ['b', 'c'], ['d']]);
	});

	it('returns no groups for an empty list', () => {
		expect(groupByDay([], (i: { createdAt: string }) => i.createdAt, NOW)).toEqual([]);
	});

	it('emits a stable YYYY-MM-DD key per group', () => {
		const groups = groupByDay(
			[item(localIso(2026, 6, 25), 'a'), item(localIso(2026, 6, 24), 'b')],
			(i) => i.createdAt,
			NOW
		);
		expect(groups.map((g) => g.key)).toEqual(['2026-07-25', '2026-07-24']);
	});

	it('does NOT merge a day that reappears non-consecutively', () => {
		// Grouping must never reorder the caller's rows: an out-of-order list
		// yields two groups for the same day rather than silently regrouping.
		const items = [
			item(localIso(2026, 6, 25), 'a'),
			item(localIso(2026, 6, 24), 'b'),
			item(localIso(2026, 6, 25), 'c')
		];
		const groups = groupByDay(items, (i) => i.createdAt, NOW);

		expect(groups).toHaveLength(3);
		expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([['a'], ['b'], ['c']]);
	});
});
