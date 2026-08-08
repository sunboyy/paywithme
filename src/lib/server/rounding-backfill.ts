// One-shot rounding-rotation backfill (ADR-0013).
//
// ADR-0013 made the leftover minor unit of a tied split ROTATE by the
// transaction's `rounding_seq`, but it applies from the migration forward: every
// pre-existing transaction sits at ordinal 0, so whichever member holds the
// lexicographically lowest UUID absorbed the odd satang on every uneven split in
// the group's history. This module walks that history, assigns each transaction
// the ordinal it WOULD have had, re-resolves it, and writes the corrected shares.
//
// ── Why this is a script and not a migration ─────────────────────────────────
// It moves real balances. A group that had settled to exactly zero can come back
// at ±0.01, which is a worse experience than the imbalance it corrects — so it is
// deliberately opt-in, previewable (`apply: false`), and audited rather than
// something that fires silently on deploy.
//
// ── Invariants it holds ──────────────────────────────────────────────────────
//   - ONE code path. Shares are recomputed by the SAME `resolveShares` /
//     `resolveItemizedWithCharges` / `distributeToSettlement` the write path uses.
//     Nothing here re-implements money math, so a backfilled transaction is
//     byte-identical to one created fresh at that ordinal.
//   - Ordinals come from `occurred_at` (the IMMUTABLE insert time), never
//     `created_at` — that one is the user-editable real-world date (§7.1), so
//     ordering by it would let a backdate reshuffle every later ordinal and move
//     shares again on a second run.
//   - Soft-deleted transactions are numbered and re-resolved too. They are
//     excluded from balances today but can be restored, and skipping them would
//     leave gaps that shift as rows are restored.
//   - Idempotent. A second run assigns the same ordinals, resolves the same
//     amounts, finds nothing changed, and writes no audit rows.
//   - Every changed transaction gets an `audit_log` row in the SAME DB
//     transaction as its writes (PLAN §12.1).

import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from './db';
import {
	transactions,
	transactionPayers,
	transactionShares,
	transactionItems,
	transactionItemShares,
	transactionCharges
} from './db/transactions-schema';
import { groups } from './db/groups-schema';
import { writeAuditLog } from './audit';
import { convertToSettlement, type ItemInput, type ChargeInput } from '$lib/schemas/transaction';
import {
	resolveShares,
	resolveItemizedWithCharges,
	distributeToSettlement
} from '$lib/transactions/resolve';
import { asEntryCurrencyCode, type SeededCurrencyCode } from '$lib/money';

/** What one transaction's re-resolution changed, in settlement minor units. */
export interface TransactionDelta {
	readonly transactionId: string;
	readonly title: string;
	/** The ordinal it has been assigned (its position in the group's history). */
	readonly roundingSeq: number;
	/** Per-member change in owed (`new - old`); only members whose owed moved. */
	readonly owedDeltas: ReadonlyMap<string, number>;
	/** Per-member change in settlement paid; moves only on foreign-currency rows. */
	readonly paidDeltas: ReadonlyMap<string, number>;
}

/** What the backfill did (or would do) to one group. */
export interface GroupReport {
	readonly groupId: string;
	readonly groupName: string;
	/** Every transaction examined, in ordinal order. */
	readonly transactionsScanned: number;
	/** Only those whose resolved amounts actually moved. */
	readonly changed: TransactionDelta[];
	/** Net per-member change in owed across the whole group. Sums to 0. */
	readonly netOwedByMember: ReadonlyMap<string, number>;
}

export interface BackfillReport {
	readonly apply: boolean;
	readonly groups: GroupReport[];
}

/**
 * Re-resolve every recorded transaction at the ordinal it would have had if
 * ADR-0013's rotation had always been in place.
 *
 * @param apply  `false` (the default) computes and reports the changes WITHOUT
 *   writing anything — the preview you should read before committing to this.
 *   `true` performs the writes, one DB transaction per affected transaction.
 * @param actorUserId  the user the audit rows are attributed to. Defaults to each
 *   group's `created_by`, which is the closest thing to "the maintainer" the
 *   ledger knows about.
 */
export async function backfillRoundingRotation({
	apply = false,
	actorUserId
}: { apply?: boolean; actorUserId?: string } = {}): Promise<BackfillReport> {
	const groupRows = await db
		.select({
			id: groups.id,
			name: groups.name,
			settlementCurrency: groups.settlementCurrency,
			createdBy: groups.createdBy
		})
		.from(groups)
		.orderBy(asc(groups.createdAt));

	const reports: GroupReport[] = [];
	for (const group of groupRows) {
		reports.push(
			await backfillGroup({
				group,
				apply,
				actorUserId: actorUserId ?? group.createdBy
			})
		);
	}
	return { apply, groups: reports };
}

async function backfillGroup({
	group,
	apply,
	actorUserId
}: {
	group: { id: string; name: string; settlementCurrency: string; createdBy: string };
	apply: boolean;
	actorUserId: string;
}): Promise<GroupReport> {
	// Ordinal order = the order the rows were actually INSERTED (`occurred_at`),
	// with `id` as a stable tie-break for same-millisecond inserts — mirroring how
	// `rounding_seq` would have been handed out had the counter always existed.
	const txnRows = await db
		.select({
			id: transactions.id,
			title: transactions.title,
			amountTotal: transactions.amountTotal,
			currency: transactions.currency,
			exchangeRate: transactions.exchangeRate,
			amountTotalSettlement: transactions.amountTotalSettlement,
			splitMode: transactions.splitMode,
			roundingSeq: transactions.roundingSeq
		})
		.from(transactions)
		.where(eq(transactions.groupId, group.id))
		.orderBy(asc(transactions.occurredAt), asc(transactions.id));

	const changed: TransactionDelta[] = [];
	const netOwedByMember = new Map<string, number>();

	for (let ordinal = 0; ordinal < txnRows.length; ordinal++) {
		const txn = txnRows[ordinal];
		const delta = await recalculateTransaction({
			txn,
			roundingSeq: ordinal,
			settlementCurrency: group.settlementCurrency as SeededCurrencyCode,
			groupId: group.id,
			actorUserId,
			apply
		});
		if (!delta) continue;

		changed.push(delta);
		for (const [memberId, d] of delta.owedDeltas) {
			netOwedByMember.set(memberId, (netOwedByMember.get(memberId) ?? 0) + d);
		}
	}

	return {
		groupId: group.id,
		groupName: group.name,
		transactionsScanned: txnRows.length,
		changed,
		netOwedByMember
	};
}

/**
 * Re-resolve ONE transaction at `roundingSeq`. Returns its delta, or `null` when
 * nothing moved (the common case: `amount` splits are passthrough, and any split
 * that divides cleanly has no leftover to rotate).
 *
 * Only the RESOLVED amounts are rewritten — never the inputs (`share_weight`,
 * `raw_amount`, item labels/amounts, charge rows), never `updated_at` (nobody
 * edited this), and never `occurred_at`. The stored inputs ARE the source this
 * re-resolves from, so touching them would destroy the thing that makes the
 * operation reproducible.
 */
async function recalculateTransaction({
	txn,
	roundingSeq,
	settlementCurrency,
	groupId,
	actorUserId,
	apply
}: {
	txn: {
		id: string;
		title: string;
		amountTotal: number;
		currency: string;
		exchangeRate: string;
		amountTotalSettlement: number;
		splitMode: string;
		roundingSeq: number;
	};
	roundingSeq: number;
	settlementCurrency: SeededCurrencyCode;
	groupId: string;
	actorUserId: string;
	apply: boolean;
}): Promise<TransactionDelta | null> {
	const [payerRows, shareRows, itemRows, chargeRows] = await Promise.all([
		db
			.select({
				memberId: transactionPayers.memberId,
				amountPaid: transactionPayers.amountPaid,
				amountPaidSettlement: transactionPayers.amountPaidSettlement
			})
			.from(transactionPayers)
			.where(eq(transactionPayers.transactionId, txn.id)),
		db
			.select({
				memberId: transactionShares.memberId,
				amountOwed: transactionShares.amountOwed,
				shareWeight: transactionShares.shareWeight,
				rawAmount: transactionShares.rawAmount
			})
			.from(transactionShares)
			.where(eq(transactionShares.transactionId, txn.id)),
		db
			.select({
				id: transactionItems.id,
				label: transactionItems.label,
				amount: transactionItems.amount,
				sortOrder: transactionItems.sortOrder
			})
			.from(transactionItems)
			.where(eq(transactionItems.transactionId, txn.id))
			.orderBy(asc(transactionItems.sortOrder)),
		db
			.select({
				kind: transactionCharges.kind,
				mode: transactionCharges.mode,
				value: transactionCharges.value,
				base: transactionCharges.base,
				sortOrder: transactionCharges.sortOrder
			})
			.from(transactionCharges)
			.where(eq(transactionCharges.transactionId, txn.id))
			.orderBy(asc(transactionCharges.sortOrder))
	]);

	const isItemized = txn.splitMode === 'itemized';

	// Rebuild the resolver's inputs from the preserved columns (PLAN §7.2 keeps
	// them for exactly this). Item beneficiaries live on `transaction_item_shares`,
	// keyed by item, each carrying its own per-item split mode.
	let itemInputs: ItemInput[] = [];
	if (isItemized) {
		itemInputs = await Promise.all(
			itemRows.map(async (item) => {
				const itemShares = await db
					.select({
						memberId: transactionItemShares.memberId,
						splitMode: transactionItemShares.splitMode,
						shareWeight: transactionItemShares.shareWeight,
						rawAmount: transactionItemShares.rawAmount
					})
					.from(transactionItemShares)
					.where(eq(transactionItemShares.itemId, item.id));
				return {
					label: item.label,
					amount: item.amount,
					splitMode: itemShares[0].splitMode as ItemInput['splitMode'],
					beneficiaries: itemShares.map((s) => ({
						memberId: s.memberId,
						shareWeight: s.shareWeight ?? undefined,
						rawAmount: s.rawAmount ?? undefined
					}))
				} satisfies ItemInput;
			})
		);
	}

	const chargeInputs: ChargeInput[] = chargeRows.map((c) => ({
		kind: c.kind as ChargeInput['kind'],
		mode: c.mode as ChargeInput['mode'],
		value: c.value,
		base: c.base as ChargeInput['base'],
		sortOrder: c.sortOrder
	}));

	// RESOLVE — the same calls, in the same order, as `resolveAndWriteTransaction`.
	const itemized = isItemized
		? resolveItemizedWithCharges(itemInputs, chargeInputs, roundingSeq)
		: null;
	const resolved = isItemized
		? itemized!.shares
		: resolveShares(
				{
					splitMode: txn.splitMode as 'equal' | 'amount' | 'share',
					amountTotal: txn.amountTotal,
					beneficiaries: shareRows.map((s) => ({
						memberId: s.memberId,
						shareWeight: s.shareWeight ?? undefined,
						rawAmount: s.rawAmount ?? undefined
					}))
				},
				roundingSeq
			);

	// Recompute the settlement total from the stored rate rather than trusting the
	// stored total — same defense-in-depth as the write path. For a same-currency
	// transaction this is the identity.
	const amountTotalSettlement = convertToSettlement(
		txn.amountTotal,
		asEntryCurrencyCode(txn.currency),
		settlementCurrency,
		txn.exchangeRate
	);

	const settlementOwed = distributeToSettlement(
		resolved.map((s) => ({ memberId: s.memberId, amount: s.amountOwed })),
		amountTotalSettlement,
		roundingSeq
	);
	const settlementPaid = distributeToSettlement(
		payerRows.map((p) => ({ memberId: p.memberId, amount: p.amountPaid })),
		amountTotalSettlement,
		roundingSeq
	);

	// DIFF against what is stored.
	const owedDeltas = new Map<string, number>();
	const newOwed = new Map(settlementOwed.map((s) => [s.memberId, s.amountOwed]));
	for (const row of shareRows) {
		const next = newOwed.get(row.memberId) ?? 0;
		if (next !== row.amountOwed) owedDeltas.set(row.memberId, next - row.amountOwed);
	}

	const paidDeltas = new Map<string, number>();
	const newPaid = new Map(settlementPaid.map((s) => [s.memberId, s.amountOwed]));
	for (const row of payerRows) {
		const next = newPaid.get(row.memberId) ?? 0;
		if (next !== row.amountPaidSettlement)
			paidDeltas.set(row.memberId, next - row.amountPaidSettlement);
	}

	// Per-item owed can move even when the aggregate does not (two items' leftovers
	// swapping between the same two members cancels out), so it is diffed too.
	const itemShareUpdates: { itemId: string; memberId: string; amountOwed: number }[] = [];
	if (isItemized) {
		for (let i = 0; i < itemRows.length; i++) {
			for (const share of itemized!.items[i].shares) {
				itemShareUpdates.push({
					itemId: itemRows[i].id,
					memberId: share.memberId,
					amountOwed: share.amountOwed
				});
			}
		}
	}

	const ordinalChanged = txn.roundingSeq !== roundingSeq;
	const amountsChanged = owedDeltas.size > 0 || paidDeltas.size > 0;
	if (!ordinalChanged && !amountsChanged) return null;

	const delta: TransactionDelta = {
		transactionId: txn.id,
		title: txn.title,
		roundingSeq,
		owedDeltas,
		paidDeltas
	};

	if (!apply) return delta;

	// WRITE — one DB transaction per ledger transaction, so a failure part-way
	// leaves earlier rows correct and the run can simply be repeated (it is
	// idempotent). The audit row joins the same transaction (PLAN §12.1).
	await db.transaction(async (tx) => {
		await tx.update(transactions).set({ roundingSeq }).where(eq(transactions.id, txn.id));

		for (const memberId of owedDeltas.keys()) {
			await tx
				.update(transactionShares)
				.set({ amountOwed: newOwed.get(memberId) ?? 0 })
				.where(
					and(eq(transactionShares.transactionId, txn.id), eq(transactionShares.memberId, memberId))
				);
		}

		for (const memberId of paidDeltas.keys()) {
			await tx
				.update(transactionPayers)
				.set({ amountPaidSettlement: newPaid.get(memberId) ?? 0 })
				.where(
					and(eq(transactionPayers.transactionId, txn.id), eq(transactionPayers.memberId, memberId))
				);
		}

		for (const u of itemShareUpdates) {
			await tx
				.update(transactionItemShares)
				.set({ amountOwed: u.amountOwed })
				.where(
					and(
						eq(transactionItemShares.itemId, u.itemId),
						eq(transactionItemShares.memberId, u.memberId)
					)
				);
		}

		if (amountsChanged) {
			await writeAuditLog(tx, {
				groupId,
				actorUserId,
				action: 'recalculate',
				entityType: 'transaction',
				entityId: txn.id,
				summary: `Recalculated rounding for '${txn.title}' (ADR-0013)`,
				metadata: {
					roundingSeq,
					owedDeltas: Object.fromEntries(owedDeltas),
					paidDeltas: Object.fromEntries(paidDeltas)
				}
			});
		}
	});

	return delta;
}

/**
 * Point each group's counter at the next free ordinal once the backfill has
 * renumbered its history, so the NEXT transaction continues the rotation instead
 * of colliding with an ordinal already in use.
 *
 * Separate from the per-transaction pass because it must run after it, and only
 * when writes were actually applied.
 */
export async function resyncGroupCounters(): Promise<void> {
	await db.execute(sql`
		update groups
		set next_rounding_seq = coalesce(
			(select count(*) from transactions where transactions.group_id = groups.id),
			0
		)
	`);
}
