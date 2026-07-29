// One-shot: re-resolve every recorded transaction under ADR-0013's rounding
// rotation, so past splits stop charging the same member every odd satang.
//
//   pnpm rounding:recalculate           # PREVIEW — reads only, writes nothing
//   pnpm rounding:recalculate --apply   # perform the writes
//
// Preview is the default ON PURPOSE: this moves real balances, and a group that
// had settled to exactly zero can come back at ±0.01. Read the report first.
//
// Safe to re-run: ordinals come from the immutable `occurred_at` order, so a
// second run resolves the same amounts, finds nothing changed, and writes nothing.
//
// Run it against the SAME database the app uses — it reads `DATABASE_URL` through
// the app's own db module, so a local `.env` pointing at production will edit
// production. Take a backup first; there is no undo beyond the audit trail.

// Load `.env` into `process.env` before anything reads it — the db module resolves
// `DATABASE_URL` through the `$env/dynamic/private` stub in `vite.script.config.ts`,
// which is just `process.env`. Node's built-in loader, so no dotenv dependency.
process.loadEnvFile();

const { formatAmount } = await import('$lib/money');
const { backfillRoundingRotation, resyncGroupCounters } =
	await import('$lib/server/rounding-backfill');
const { db } = await import('$lib/server/db');
const { groups, members } = await import('$lib/server/db/groups-schema');

type CurrencyCode = import('$lib/money').CurrencyCode;
type BackfillReport = import('$lib/server/rounding-backfill').BackfillReport;

const apply = process.argv.includes('--apply');

/** Member display names, so the report names people rather than UUIDs. */
async function memberNames(): Promise<Map<string, string>> {
	const rows = await db.select({ id: members.id, displayName: members.displayName }).from(members);
	return new Map(rows.map((r) => [r.id, r.displayName]));
}

/** Each group's settlement currency, for formatting the deltas correctly. */
async function groupCurrencies(): Promise<Map<string, CurrencyCode>> {
	const rows = await db
		.select({ id: groups.id, settlementCurrency: groups.settlementCurrency })
		.from(groups);
	return new Map(rows.map((r) => [r.id, r.settlementCurrency as CurrencyCode]));
}

function printReport(
	report: BackfillReport,
	names: Map<string, string>,
	currencies: Map<string, CurrencyCode>
): number {
	let totalChanged = 0;

	for (const group of report.groups) {
		const currency = currencies.get(group.groupId) ?? ('USD' as CurrencyCode);
		const name = (id: string) => names.get(id) ?? id;
		const money = (minor: number) =>
			`${minor > 0 ? '+' : ''}${formatAmount(minor, currency, { code: false })}`;

		if (group.changed.length === 0) {
			console.log(`\n${group.groupName} — ${group.transactionsScanned} transactions, no change`);
			continue;
		}

		totalChanged += group.changed.length;
		console.log(
			`\n${group.groupName} — ${group.changed.length} of ${group.transactionsScanned} transactions change`
		);

		for (const txn of group.changed) {
			const moves = [...txn.owedDeltas]
				.map(([memberId, delta]) => `${name(memberId)} ${money(delta)}`)
				.join(', ');
			console.log(`  #${txn.roundingSeq} ${txn.title}: ${moves || '(ordinal only)'}`);
		}

		// The line that actually matters: who ends up better or worse off overall.
		console.log('  net:');
		const net = [...group.netOwedByMember].sort((a, b) => a[1] - b[1]);
		for (const [memberId, delta] of net) {
			// A NEGATIVE change in owed means this member owes less than before.
			console.log(`    ${name(memberId)} owes ${money(delta)}`);
		}
	}

	return totalChanged;
}

const names = await memberNames();
const currencies = await groupCurrencies();

console.log(
	apply
		? 'Recalculating rounding (ADR-0013) — APPLYING CHANGES'
		: 'Recalculating rounding (ADR-0013) — preview only, nothing will be written'
);

const report = await backfillRoundingRotation({ apply });
const totalChanged = printReport(report, names, currencies);

if (apply) {
	// Point every counter past the ordinals just assigned, so the next transaction
	// continues the rotation instead of reusing one.
	await resyncGroupCounters();
	console.log(`\nApplied. ${totalChanged} transaction(s) rewritten; group counters resynced.`);
} else if (totalChanged > 0) {
	console.log(`\n${totalChanged} transaction(s) would change. Re-run with --apply to write them.`);
} else {
	console.log('\nNothing to do — every transaction already matches its rotated ordinal.');
}

process.exit(0);
