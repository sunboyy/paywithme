// Shared client-side presentation helpers for the audit trail (PLAN §12.1) — used
// by BOTH the group activity feed (`/groups/[id]/activity`, task 6.2) and the
// per-transaction history section (`/groups/[id]/transactions/[txid]`, task 6.3).
// ONE source of truth for the action-verb labels and the relative/absolute time
// formatting, so the two views read identically.
//
// All times render in the VIEWER's locale/timezone (§12.1) — these run client-side
// from the durable ISO string the service serializes.

/**
 * Human-readable label per audit action verb (PLAN §12.1 "action"). Falls back to
 * the raw verb for any future action not yet mapped.
 */
const ACTION_LABELS: Record<string, string> = {
	create: 'created',
	edit: 'edited',
	delete: 'deleted',
	restore: 'restored',
	add: 'added',
	deactivate: 'deactivated',
	reactivate: 'reactivated',
	revoke: 'revoked',
	rename: 'renamed',
	currency_set: 'set currency'
};

/** Map an audit action verb to its human label (raw verb fallback). */
export function actionLabel(action: string): string {
	return ACTION_LABELS[action] ?? action;
}

/** Absolute time in the viewer's locale/timezone (§12.1). */
export function absoluteTime(iso: string): string {
	return new Date(iso).toLocaleString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
	{ amount: 60, unit: 'second' },
	{ amount: 60, unit: 'minute' },
	{ amount: 24, unit: 'hour' },
	{ amount: 7, unit: 'day' },
	{ amount: 4.34524, unit: 'week' },
	{ amount: 12, unit: 'month' },
	{ amount: Number.POSITIVE_INFINITY, unit: 'year' }
];

/** Locale-aware "2 hours ago" / "in 3 days" relative time from an ISO string. */
export function relativeTime(iso: string): string {
	let delta = (new Date(iso).getTime() - Date.now()) / 1000; // seconds, signed
	for (const { amount, unit } of DIVISIONS) {
		if (Math.abs(delta) < amount) return RELATIVE.format(Math.round(delta), unit);
		delta /= amount;
	}
	return RELATIVE.format(Math.round(delta), 'year');
}
