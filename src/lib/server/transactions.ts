// Transaction service — the testable business logic for creating + listing
// transactions (task 4.7; PLAN §7.1, §7.2, §7.3, §9, §12.1). CLAUDE.md:
// "Business logic in lib/server/".
//
// This is the SERVER-SIDE SERVICE LAYER only — NOT routes/pages. The add page
// (`/groups/[id]/transactions/new`) and the list page (`/groups/[id]/transactions`)
// are the route half of task 4.7. The view/edit page + soft-delete/restore are
// task 4.11.
//
// ── Scope (task 4.7) ──────────────────────────────────────────────────────────
// `createTransaction` + `listTransactions` for split_mode ∈ { equal, amount,
// share } in the GROUP'S SETTLEMENT CURRENCY only (single-currency). For this task
// the entry currency IS the settlement currency, so:
//   - `exchange_rate = '1'`,
//   - `amount_total_settlement == amount_total`,
//   - each payer's `amount_paid_settlement == amount_paid`,
//   - each share's settlement `amount_owed` == the txn-currency resolved owed.
// Task 4.8 ADDS `itemized` split resolution + persistence (transaction_items /
// transaction_item_shares + aggregated transaction_shares) on top of this.
// Deliberately NOT here (later tasks own them, with clean seams left):
//   - charges / discounts                                          → task 4.9.
//   - multi-currency / manual FX (currency picker, rate entry)     → task 4.10.
//   - `updateTransaction` / soft-delete / restore                  → task 4.11.
//
// ── Validate → resolve → persist (the create flow) ────────────────────────────
// The service NEVER trusts client-resolved amounts. It RE-BUILDS the shared
// `buildTransactionSchema` from the group's settlement currency + active member
// ids and RE-VALIDATES the input, then RE-RESOLVES the per-member owed amounts via
// the shared `resolveShares`. Only then, in ONE `db.transaction(...)`, it inserts
// the `transactions` row, the `transaction_payers` rows, the `transaction_shares`
// rows, AND the `audit_log` row — all through the same `tx` so the audit trail can
// never drift from the ledger (PLAN §12.1).
//
// ── Authorization (PLAN §12) ──────────────────────────────────────────────────
// Group-membership only. Every function gates on `userHasGroupAccess` (the 3.3
// primitive) and throws `GroupAccessError` (→ 404) on no access. The route layer
// also guards, but the service re-asserts (defense in depth, consistent with
// groups.ts / members.ts).
//
// ── Timestamps (PLAN §7.1 — DELIBERATELY REVERSED) ────────────────────────────
// `created_at` = the USER-SUPPLIED real-world date (default now). `occurred_at`
// (immutable server insert time) and `updated_at` are left to the DB defaults.

import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db';
import {
	categories,
	transactions,
	transactionPayers,
	transactionShares,
	transactionItems,
	transactionItemShares
} from './db/transactions-schema';
import { members } from './db/groups-schema';
import { GroupAccessError, userHasGroupAccess } from './groups';
import { writeAuditLog } from './audit';
import { buildTransactionSchema, type TransactionInput } from '$lib/schemas/transaction';
import {
	resolveShares,
	resolveItemizedShares,
	type ResolvedShare
} from '$lib/transactions/resolve';
import { getCategory } from '$lib/categories';
import { formatAmount, type CurrencyCode } from '$lib/money';

/** A query runner: either the lazy `db` proxy or an open transaction handle. */
type DbExecutor = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>;

/**
 * The submitted transaction input failed server-side validation (the SAME shared
 * `buildTransactionSchema` the client uses). Carries the Zod issues so the route
 * can surface them on the form rather than 500-ing (PLAN §7.4). Distinct from the
 * access error so the route can branch (400-ish form failure vs 404).
 */
export class TransactionValidationError extends Error {
	readonly code = 'transaction_invalid' as const;
	readonly issues: z.core.$ZodIssue[];
	constructor(issues: z.core.$ZodIssue[], message = 'Transaction is invalid') {
		super(message);
		this.name = 'TransactionValidationError';
		this.issues = issues;
	}
}

/**
 * Assert access or throw `GroupAccessError` (→ 404). Thin wrapper over the 3.3
 * primitive so "no access" / "soft-deleted group" is a single not-found outcome,
 * mirroring groups.ts / members.ts.
 */
async function assertGroupAccess(
	userId: string,
	groupId: string,
	executor: DbExecutor = db
): Promise<void> {
	if (!(await userHasGroupAccess(userId, groupId, executor))) {
		throw new GroupAccessError();
	}
}

/** Active (non-deactivated) member ids of a group — the schema's member allow-list. */
async function activeMemberIds(groupId: string, executor: DbExecutor = db): Promise<string[]> {
	const rows = await executor
		.select({ id: members.id })
		.from(members)
		.where(and(eq(members.groupId, groupId), isNull(members.deactivatedAt)));
	return rows.map((r) => r.id);
}

/**
 * Create a transaction (PLAN §7.1, §7.2, §12.1) for split_mode ∈ {equal, amount,
 * share} in the group's settlement currency.
 *
 * Flow: assert access → load the group's settlement currency + active member ids →
 * RE-BUILD the shared schema from them and RE-VALIDATE the input (never trust the
 * client) → RE-RESOLVE per-member owed via the shared `resolveShares` → in ONE
 * `db.transaction`: insert the transaction row + payer rows + share rows + the
 * audit row, all through `tx`. Returns the new transaction id.
 *
 * @throws {GroupAccessError} (→404) when the user has no access to the group.
 * @throws {TransactionValidationError} when the input fails the shared schema.
 */
export async function createTransaction({
	userId,
	groupId,
	input,
	settlementCurrency,
	now = () => new Date()
}: {
	userId: string;
	groupId: string;
	/** The RAW, parsed-to-minor-units input (client already ran `parseAmount`). */
	input: unknown;
	/**
	 * The group's settlement currency. The route loads it from the group row and
	 * passes it (group context — NEVER trusted from the payload). Optional only so
	 * tests can omit it; production callers always pass it.
	 */
	settlementCurrency?: CurrencyCode;
	/** Injectable clock (tests). Defaults to the real `now`. */
	now?: () => Date;
}): Promise<string> {
	return db.transaction(async (tx) => {
		await assertGroupAccess(userId, groupId, tx);

		// Settlement currency is GROUP CONTEXT. Prefer the passed value (loaded from
		// the group row by the route); fall back to a tx read so the service is
		// usable standalone. NEVER read it from the payload.
		const currency = settlementCurrency ?? (await loadSettlementCurrency(groupId, tx));

		// Build the schema server-side from the group's settlement currency + active
		// member ids, then RE-VALIDATE — the single source of truth (task 4.4). The
		// member allow-list rejects payers/beneficiaries outside the group.
		const memberIds = await activeMemberIds(groupId, tx);
		const schema = buildTransactionSchema({ settlementCurrency: currency, memberIds });
		const parsed = schema.safeParse(input);
		if (!parsed.success) {
			throw new TransactionValidationError(parsed.error.issues);
		}
		const data = parsed.data;

		// 4.7 is single-currency: itemized/charges/FX are later tasks. Guard the seam
		// so a payload that smuggles them in is rejected here rather than silently
		// dropped (4.8/4.9/4.10 will replace these guards with real handling).
		assertSingleCurrencyScope(data, currency);

		// Category must exist in the seeded set AND match the type (the schema already
		// checks the in-app constant; this is the DB-existence half, task 4.7's job).
		await assertCategoryExists(data.categoryId, tx);

		// RE-RESOLVE per-member owed amounts server-side (never trust the client). For
		// currency==settlement the txn-currency owed IS the settlement owed. Itemized
		// resolves each item (rounding within the item) and aggregates per member; the
		// per-item resolutions are persisted too (transaction_item_shares).
		const isItemized = data.splitMode === 'itemized';
		const itemized = isItemized ? resolveItemizedShares(data.items) : null;
		const resolved: ResolvedShare[] = isItemized
			? itemized!.shares
			: resolveShares({
					splitMode: data.splitMode as Exclude<TransactionInput['splitMode'], 'itemized'>,
					amountTotal: data.amountTotal,
					beneficiaries: data.beneficiaries
				});

		const transactionId = crypto.randomUUID();

		// 1) The transaction row. `created_at` = the user's real-world date (default
		//    now); `occurred_at` / `updated_at` left to the DB defaults (§7.1).
		await tx.insert(transactions).values({
			id: transactionId,
			groupId,
			type: data.type,
			title: data.title,
			categoryId: data.categoryId,
			amountTotal: data.amountTotal,
			currency,
			// Single-currency: rate is exactly 1, settlement total == txn total (§7.6).
			exchangeRate: '1',
			amountTotalSettlement: data.amountTotal,
			splitMode: data.splitMode,
			createdBy: userId,
			createdAt: now()
		});

		// 2) Payer rows. amount_paid_settlement == amount_paid (currency==settlement).
		for (const payer of data.payers) {
			await tx.insert(transactionPayers).values({
				transactionId,
				memberId: payer.memberId,
				amountPaid: payer.amountPaid,
				amountPaidSettlement: payer.amountPaid
			});
		}

		// 3) For ITEMIZED: persist the item rows + per-item share rows (§7.2.1), then
		//    the AGGREGATED transaction_share rows (per-member total owed, the §8 source
		//    of truth). For non-itemized: persist the resolved share rows directly.
		if (isItemized) {
			// 3a) One transaction_items row per item (label, amount, sort_order), and its
			//     transaction_item_shares (resolved per-item owed + the per-item split
			//     inputs preserved for 4.11 re-edit). All through the same `tx`.
			for (let i = 0; i < data.items.length; i++) {
				const item = data.items[i];
				const itemId = crypto.randomUUID();
				await tx.insert(transactionItems).values({
					id: itemId,
					transactionId,
					label: item.label,
					amount: item.amount,
					sortOrder: i
				});
				const itemShares = itemized!.items[i].shares;
				for (const beneficiary of item.beneficiaries) {
					const owed = itemShares.find((s) => s.memberId === beneficiary.memberId)?.amountOwed ?? 0;
					await tx.insert(transactionItemShares).values({
						itemId,
						memberId: beneficiary.memberId,
						amountOwed: owed,
						splitMode: item.splitMode,
						shareWeight: beneficiary.shareWeight ?? null,
						rawAmount: beneficiary.rawAmount ?? null
					});
				}
			}

			// 3b) Aggregated per-member transaction_share rows. No top-level inputs for an
			//     itemized split (per-item inputs live on transaction_item_shares), so the
			//     share_weight / raw_amount are null here.
			for (const share of resolved) {
				await tx.insert(transactionShares).values({
					transactionId,
					memberId: share.memberId,
					amountOwed: share.amountOwed,
					shareWeight: null,
					rawAmount: null
				});
			}
		} else {
			// Non-itemized share rows. The RESOLVED owed (txn-currency) == settlement owed
			// here. The raw inputs (share_weight / raw_amount) are preserved for 4.11.
			for (const beneficiary of data.beneficiaries) {
				const owed = resolved.find((r) => r.memberId === beneficiary.memberId)?.amountOwed ?? 0;
				await tx.insert(transactionShares).values({
					transactionId,
					memberId: beneficiary.memberId,
					amountOwed: owed,
					shareWeight: beneficiary.shareWeight ?? null,
					rawAmount: beneficiary.rawAmount ?? null
				});
			}
		}

		// 4) Audit row — IN THE SAME TRANSACTION (PLAN §12.1). Human summary via
		//    `lib/money` `formatAmount` (e.g. "Added spending 'Dinner' — ฿90.00").
		await writeAuditLog(tx, {
			groupId,
			actorUserId: userId,
			action: 'create',
			entityType: 'transaction',
			entityId: transactionId,
			summary: `Added ${data.type} '${data.title}' — ${formatAmount(data.amountTotal, currency)}`,
			metadata: {
				type: data.type,
				categoryId: data.categoryId,
				amountTotal: data.amountTotal,
				currency,
				splitMode: data.splitMode
			}
		});

		return transactionId;
	});
}

/**
 * Load a group's settlement currency (used when the route didn't pass it). Runs on
 * the supplied executor so it shares the create transaction. Throws
 * `GroupAccessError` if the group vanished (access was already asserted).
 */
async function loadSettlementCurrency(
	groupId: string,
	executor: DbExecutor
): Promise<CurrencyCode> {
	// Import locally to avoid a top-level cycle through groups-schema's re-exports.
	const { groups } = await import('./db/groups-schema');
	const [row] = await executor
		.select({ settlementCurrency: groups.settlementCurrency })
		.from(groups)
		.where(and(eq(groups.id, groupId), isNull(groups.deletedAt)))
		.limit(1);
	if (!row) {
		throw new GroupAccessError();
	}
	return row.settlementCurrency as CurrencyCode;
}

/**
 * Guard the supported scope. As of task 4.8 itemized splits + (non-empty) `items`
 * are ALLOWED (resolved + persisted below); `charges` and foreign currency stay
 * REJECTED here (tasks 4.9 / 4.10). The shared schema validates the full payload,
 * so a hand-crafted payload could smuggle a deferred feature past validation;
 * reject those HERE with a clear seam rather than silently persisting them.
 */
function assertSingleCurrencyScope(data: TransactionInput, settlementCurrency: CurrencyCode): void {
	const issues: z.core.$ZodIssue[] = [];
	// Itemized split + items are now supported (task 4.8) — no longer rejected.
	if (data.charges.length > 0) {
		// Charges / discounts are task 4.9.
		issues.push(makeIssue(['charges'], 'Charges are not supported yet'));
	}
	if (data.currency !== settlementCurrency) {
		// Multi-currency / manual FX is task 4.10.
		issues.push(makeIssue(['currency'], 'Foreign-currency transactions are not supported yet'));
	}
	if (issues.length > 0) {
		throw new TransactionValidationError(issues);
	}
}

/** Build a minimal custom Zod issue for the scope guards above. */
function makeIssue(path: (string | number)[], message: string): z.core.$ZodIssue {
	return { code: 'custom', path, message } as z.core.$ZodIssue;
}

/** Assert the category id exists in the seeded `categories` table (DB-existence half). */
async function assertCategoryExists(categoryId: string, executor: DbExecutor): Promise<void> {
	// The shared schema already verified the id is a known in-app category whose
	// `applies_to` matches the type; this confirms the seed row physically exists.
	if (getCategory(categoryId) === undefined) {
		throw new TransactionValidationError([
			makeIssue(['categoryId'], 'Select a category for this transaction type')
		]);
	}
	const rows = await executor
		.select({ id: categories.id })
		.from(categories)
		.where(eq(categories.id, categoryId))
		.limit(1);
	if (rows.length === 0) {
		throw new TransactionValidationError([makeIssue(['categoryId'], 'Unknown category')]);
	}
}

/** Filters for {@link listTransactions} (PLAN §10 list filters). */
export interface TransactionListFilters {
	/** Restrict to a transaction `type` ('spending' | 'transfer'). */
	type?: 'spending' | 'transfer';
	/** Restrict to a category id. */
	categoryId?: string;
}

/** The shape the list page renders per transaction row. */
export interface TransactionListItem {
	id: string;
	type: 'spending' | 'transfer';
	title: string;
	categoryId: string;
	categoryName: string;
	categoryIcon: string;
	/** Settlement-currency minor units (the canonical total §8 reads). */
	amountTotalSettlement: number;
	/** Group settlement currency code — what `amountTotalSettlement` is denominated in. */
	settlementCurrency: CurrencyCode;
	/** The real-world date (PLAN §7.1 `created_at`), ISO string — the display/sort date. */
	createdAt: string;
}

/**
 * List a group's non-soft-deleted transactions, newest first by `created_at` (the
 * §7.1 display/sort date), with category name/icon + the settlement total.
 * Access-checked. Supports filtering by `type` and `categoryId` (PLAN §10).
 */
export async function listTransactions({
	userId,
	groupId,
	filters = {}
}: {
	userId: string;
	groupId: string;
	filters?: TransactionListFilters;
}): Promise<TransactionListItem[]> {
	await assertGroupAccess(userId, groupId);

	const conditions = [
		eq(transactions.groupId, groupId),
		// Exclude soft-deleted (task 4.11 sets deleted_at).
		isNull(transactions.deletedAt)
	];
	if (filters.type) {
		conditions.push(eq(transactions.type, filters.type));
	}
	if (filters.categoryId) {
		conditions.push(eq(transactions.categoryId, filters.categoryId));
	}

	const rows = await db
		.select({
			id: transactions.id,
			type: transactions.type,
			title: transactions.title,
			categoryId: transactions.categoryId,
			categoryName: categories.name,
			categoryIcon: categories.icon,
			amountTotalSettlement: transactions.amountTotalSettlement,
			currency: transactions.currency,
			createdAt: transactions.createdAt
		})
		.from(transactions)
		.innerJoin(categories, eq(transactions.categoryId, categories.id))
		.where(and(...conditions))
		// Newest first by the real-world date (§7.1 `created_at`); `occurred_at` is
		// the immutable insert-time tie-break.
		.orderBy(desc(transactions.createdAt), desc(transactions.occurredAt));

	// `currency` on a transaction is the ENTRY currency; for 4.7 it equals the
	// group settlement currency (single-currency), so the settlement total is
	// denominated in it. (4.10 will load the group's settlement currency directly.)
	return rows.map((r) => ({
		id: r.id,
		type: r.type as 'spending' | 'transfer',
		title: r.title,
		categoryId: r.categoryId,
		categoryName: r.categoryName,
		categoryIcon: r.categoryIcon,
		amountTotalSettlement: r.amountTotalSettlement,
		settlementCurrency: r.currency as CurrencyCode,
		createdAt: r.createdAt.toISOString()
	}));
}
