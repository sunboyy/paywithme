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
// transaction_item_shares + aggregated transaction_shares) on top of this; task
// 4.9 ADDS charges/discounts (proportional allocation + transaction_charges rows).
// Deliberately NOT here (later tasks own them, with clean seams left):
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
// `created_at` = the USER-EDITABLE real-world date (`data.date`, a calendar day;
// defaults to today). `occurred_at` = the immutable server insert time (DB default,
// the same-day sort tie-break). `updated_at` = real `now()`, bumped on every edit
// (NOT the editable date — an edit's wall-clock time, decoupled from `created_at`).

import { and, asc, desc, eq, inArray, isNull, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db';
import {
	categories,
	transactions,
	transactionPayers,
	transactionShares,
	transactionItems,
	transactionItemShares,
	transactionCharges
} from './db/transactions-schema';
import { members } from './db/groups-schema';
import { GroupAccessError, userHasGroupAccess } from './groups';
import { writeAuditLog } from './audit';
import {
	buildTransactionSchema,
	convertToSettlement,
	type TransactionInput
} from '$lib/schemas/transaction';
import {
	resolveShares,
	resolveItemizedWithCharges,
	distributeToSettlement,
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
 * Tried to edit a SOFT-DELETED transaction (PLAN §9). A deleted txn is still
 * viewable (so it can be restored) but must be RESTORED before it can be edited —
 * editing it would silently resurrect deleted data. Distinct from the access /
 * validation errors so the route can branch (→ a clear "restore first" message, not
 * a 404 or a form failure). The txn's existence is NOT leaked by this error: it only
 * ever surfaces AFTER the access + existence checks have passed.
 */
export class TransactionDeletedError extends Error {
	readonly code = 'transaction_deleted' as const;
	constructor(message = 'This transaction has been deleted. Restore it before editing.') {
		super(message);
		this.name = 'TransactionDeletedError';
	}
}

/**
 * A transaction was not found (in this group, not soft-deleted-vs-missing
 * distinguished only where intended) for the requested op. The route maps this to a
 * 404 exactly like `GroupAccessError`, so a txn in another group / a bogus id never
 * leaks (PLAN §12 "don't leak existence").
 */
export class TransactionNotFoundError extends Error {
	readonly code = 'transaction_not_found' as const;
	constructor(message = 'Transaction not found') {
		super(message);
		this.name = 'TransactionNotFoundError';
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

		// Category must exist in the seeded set AND match the type (the schema already
		// checks the in-app constant; this is the DB-existence half, task 4.7's job).
		await assertCategoryExists(data.categoryId, tx);

		const transactionId = crypto.randomUUID();

		// RESOLVE + WRITE the transaction row + ALL child rows (payers / shares / items /
		// item-shares / charges) through the shared helper that `updateTransaction` also
		// calls, so create and edit re-resolve IDENTICALLY (settlement amounts recomputed
		// server-side from the trusted currency/rate, never trusted from the client).
		const { amountTotalSettlement } = await resolveAndWriteTransaction(tx, {
			mode: 'create',
			transactionId,
			groupId,
			userId,
			settlementCurrency: currency,
			data,
			now
		});

		// Audit row — IN THE SAME TRANSACTION (PLAN §12.1). Human summary via
		// `lib/money` `formatAmount` in the ENTRY currency (e.g. "Added spending
		// 'Dinner' — ฿90.00"); for a foreign transaction the settlement equivalent
		// is appended (e.g. "CN¥90.00 (฿436.50)", §7.6).
		const entryCurrency = data.currency as CurrencyCode;
		const isForeign = entryCurrency !== currency;
		const amountSummary = isForeign
			? `${formatAmount(data.amountTotal, entryCurrency)} (${formatAmount(amountTotalSettlement, currency)})`
			: formatAmount(data.amountTotal, entryCurrency);
		await writeAuditLog(tx, {
			groupId,
			actorUserId: userId,
			action: 'create',
			entityType: 'transaction',
			entityId: transactionId,
			summary: `Added ${data.type} '${data.title}' — ${amountSummary}`,
			metadata: {
				type: data.type,
				categoryId: data.categoryId,
				amountTotal: data.amountTotal,
				currency: entryCurrency,
				amountTotalSettlement,
				settlementCurrency: currency,
				splitMode: data.splitMode
			}
		});

		return transactionId;
	});
}

/**
 * Map the validated `YYYY-MM-DD` editable date (§7.1) to the `created_at` instant.
 * We anchor it at **noon UTC** of that calendar day: the column is a bare timestamp
 * displayed via the viewer's locale (`toLocaleDateString`), and noon keeps the
 * rendered day equal to the picked day across every realistic timezone (≈UTC-12..+11)
 * — midnight would shift west-of-UTC viewers a day earlier. The precise insert time
 * lives in the immutable `occurred_at` (the same-day sort tie-break), so `created_at`
 * deliberately carries only a day.
 */
function dateOnlyToCreatedAt(day: string): Date {
	return new Date(`${day}T12:00:00.000Z`);
}

/**
 * The SHARED "re-resolve + write the transaction row + replace all child rows"
 * engine that BOTH {@link createTransaction} and {@link updateTransaction} call, so
 * an edit re-resolves byte-identically to a create (PLAN §7.2/§7.6). It NEVER trusts
 * client-resolved/settlement values — it recomputes them server-side from the
 * trusted group currency + the validated rate.
 *
 * On `mode: 'create'` it INSERTS the `transactions` row; on `mode: 'edit'` it
 * UPDATES the existing row in place (keeping `id` + the immutable `occurred_at`,
 * setting `created_at` from the validated user date, bumping `updated_at` to now)
 * and the caller has already deleted this txn's child rows — either way it then
 * (re)inserts the freshly-resolved payer / share / item / item-share / charge rows.
 *
 * Runs entirely on the caller's open transaction handle (`exec`) so every write
 * joins the one `db.transaction` the audit row also lives in (§12.1). Returns the
 * server-recomputed `amountTotalSettlement` for the caller's audit summary.
 */
async function resolveAndWriteTransaction(
	exec: DbExecutor,
	args: {
		mode: 'create' | 'edit';
		transactionId: string;
		groupId: string;
		userId: string;
		settlementCurrency: CurrencyCode;
		data: TransactionInput;
		/** Injectable clock — the real `now`, used for `updated_at` on edit (tests). */
		now: () => Date;
	}
): Promise<{ amountTotalSettlement: number }> {
	const { transactionId, groupId, userId, settlementCurrency: currency, data, now } = args;

	// Canonical settlement total — RECOMPUTED server-side from trusted context (the
	// validated currency/rate), NEVER trusting the client's `amountTotalSettlement`
	// (defense in depth; the schema already validated the client value equals this).
	const amountTotalSettlement = convertToSettlement(
		data.amountTotal,
		data.currency as CurrencyCode,
		currency,
		data.exchangeRate
	);

	// RE-RESOLVE per-member owed amounts server-side (never trust the client). For
	// currency==settlement the txn-currency owed IS the settlement owed. Itemized
	// resolves each item (rounding within the item), aggregates per member, then
	// ALLOCATES each charge/discount across members by subtotal share (§7.2.3); the
	// per-item resolutions AND the charge rows are persisted too. The aggregated
	// `resolved` shares are the FINAL owed (subtotal ± allocated charges).
	const isItemized = data.splitMode === 'itemized';
	const itemized = isItemized ? resolveItemizedWithCharges(data.items, data.charges) : null;
	const resolved: ResolvedShare[] = isItemized
		? itemized!.shares
		: resolveShares({
				splitMode: data.splitMode as Exclude<TransactionInput['splitMode'], 'itemized'>,
				amountTotal: data.amountTotal,
				beneficiaries: data.beneficiaries
			});

	// CONVERT-THEN-DISTRIBUTE into settlement currency (PLAN §7.6). Splitting /
	// itemization / charges all ran in the TXN currency above (per-member owed,
	// per-payer paid). Now a SINGLE conversion of the total → `amountTotalSettlement`,
	// then distribute THAT one settlement total across members weighted by their
	// txn-currency owed (and across payers weighted by their txn-currency paid) via
	// `distributeToSettlement` (largest-remainder). Distributing the SAME total to both
	// sides ties paid and owed to one number, so Σ owed == Σ paid == amountTotalSettlement
	// and group balances always net to 0. For currency==settlement this is a
	// byte-identical no-op (rate 1, settlement total == txn total).
	const settlementOwed = distributeToSettlement(
		resolved.map((s) => ({ memberId: s.memberId, amount: s.amountOwed })),
		amountTotalSettlement
	);
	const settlementOwedByMember = new Map(settlementOwed.map((s) => [s.memberId, s.amountOwed]));
	const settlementPaid = distributeToSettlement(
		data.payers.map((p) => ({ memberId: p.memberId, amount: p.amountPaid })),
		amountTotalSettlement
	);
	const settlementPaidByMember = new Map(settlementPaid.map((s) => [s.memberId, s.amountOwed]));

	// 1) The transaction row. `created_at` = the user's EDITABLE real-world date
	//    (`data.date`, a calendar day → noon UTC §7.1). On CREATE we INSERT; on EDIT
	//    we UPDATE IN PLACE — keeping the immutable `occurred_at` untouched, setting
	//    `created_at` from the validated date, and bumping `updated_at` to the real
	//    `now()` (an edit's wall-clock time, decoupled from the date — §7.1 reversed).
	const createdAt = dateOnlyToCreatedAt(data.date);
	if (args.mode === 'create') {
		await exec.insert(transactions).values({
			id: transactionId,
			groupId,
			type: data.type,
			title: data.title,
			categoryId: data.categoryId,
			amountTotal: data.amountTotal,
			// The REAL entry currency + manual FX rate (§7.6) — no longer hardcoded '1'.
			currency: data.currency,
			exchangeRate: data.exchangeRate,
			// Server-recomputed canonical settlement total (defense in depth, §7.6).
			amountTotalSettlement,
			splitMode: data.splitMode,
			createdBy: userId,
			createdAt
			// `occurred_at` / `updated_at` left to the DB defaults (§7.1).
		});
	} else {
		await exec
			.update(transactions)
			.set({
				type: data.type,
				title: data.title,
				categoryId: data.categoryId,
				amountTotal: data.amountTotal,
				currency: data.currency,
				exchangeRate: data.exchangeRate,
				amountTotalSettlement,
				splitMode: data.splitMode,
				// `created_at` is the EDITABLE real-world date (§7.1) — set from the input.
				createdAt,
				// `updated_at` bumped to the real `now()` on every edit (§7.1). `occurred_at`
				// is IMMUTABLE and deliberately NOT in this set — it is never touched on edit.
				updatedAt: now()
			})
			.where(eq(transactions.id, transactionId));
	}

	// 2) Payer rows. `amount_paid` stays in the TXN currency; `amount_paid_settlement`
	//    is the settlement-DISTRIBUTED paid (§7.6) — Σ == amountTotalSettlement.
	for (const payer of data.payers) {
		await exec.insert(transactionPayers).values({
			transactionId,
			memberId: payer.memberId,
			amountPaid: payer.amountPaid,
			amountPaidSettlement: settlementPaidByMember.get(payer.memberId) ?? 0
		});
	}

	// 3) For ITEMIZED: persist the item rows + per-item share rows (§7.2.1), then
	//    the AGGREGATED transaction_share rows (per-member total owed, the §8 source
	//    of truth). For non-itemized: persist the resolved share rows directly.
	if (isItemized) {
		// 3a) One transaction_items row per item (label, amount, sort_order), and its
		//     transaction_item_shares (resolved per-item owed + the per-item split
		//     inputs preserved for 4.11 re-edit). All through the same `exec`.
		for (let i = 0; i < data.items.length; i++) {
			const item = data.items[i];
			const itemId = crypto.randomUUID();
			await exec.insert(transactionItems).values({
				id: itemId,
				transactionId,
				label: item.label,
				amount: item.amount,
				sortOrder: i
			});
			const itemShares = itemized!.items[i].shares;
			for (const beneficiary of item.beneficiaries) {
				const owed = itemShares.find((s) => s.memberId === beneficiary.memberId)?.amountOwed ?? 0;
				await exec.insert(transactionItemShares).values({
					itemId,
					memberId: beneficiary.memberId,
					amountOwed: owed,
					splitMode: item.splitMode,
					shareWeight: beneficiary.shareWeight ?? null,
					rawAmount: beneficiary.rawAmount ?? null
				});
			}
		}

		// 3b) transaction_charges rows (§7.2.2): the raw charge inputs
		//     (kind/mode/value/base/sort_order), preserved so 4.11 edit can re-read
		//     them. The signed effect + per-member allocation are DERIVED on read via
		//     the resolver, so only the inputs are stored. Through the same `exec`.
		for (const charge of data.charges) {
			await exec.insert(transactionCharges).values({
				transactionId,
				kind: charge.kind,
				mode: charge.mode,
				value: charge.value,
				base: charge.base,
				sortOrder: charge.sortOrder
			});
		}

		// 3c) Aggregated per-member transaction_share rows — the FINAL owed (subtotal
		//     ± allocated charges, §7.2.3). No top-level inputs for an itemized split
		//     (per-item inputs live on transaction_item_shares), so the
		//     share_weight / raw_amount are null here.
		for (const share of resolved) {
			await exec.insert(transactionShares).values({
				transactionId,
				memberId: share.memberId,
				// SETTLEMENT-distributed owed (§7.6); §8 reads this. Σ == amountTotalSettlement.
				amountOwed: settlementOwedByMember.get(share.memberId) ?? 0,
				shareWeight: null,
				rawAmount: null
			});
		}
	} else {
		// Non-itemized share rows. The RESOLVED owed (txn-currency) == settlement owed
		// here. The raw inputs (share_weight / raw_amount) are preserved for 4.11.
		for (const beneficiary of data.beneficiaries) {
			// SETTLEMENT-distributed owed (§7.6) — the §8 source of truth. The raw inputs
			// (share_weight / raw_amount, TXN currency) are preserved for 4.11 re-edit.
			await exec.insert(transactionShares).values({
				transactionId,
				memberId: beneficiary.memberId,
				amountOwed: settlementOwedByMember.get(beneficiary.memberId) ?? 0,
				shareWeight: beneficiary.shareWeight ?? null,
				rawAmount: beneficiary.rawAmount ?? null
			});
		}
	}

	return { amountTotalSettlement };
}

/** Delete EVERY child row of a transaction (payers / shares / items / item-shares /
 *  charges) through the open transaction handle — the "replace children" half of an
 *  edit (PLAN §7.2 re-edit). item-shares are deleted via their parent items' ids
 *  (they key on `item_id`, not `transaction_id`), so we look those up first. All on
 *  `exec` so the deletes join the same `db.transaction` as the re-insert + audit. */
async function deleteTransactionChildren(exec: DbExecutor, transactionId: string): Promise<void> {
	// item-shares reference items by `item_id`; resolve this txn's item ids first.
	const itemRows = await exec
		.select({ id: transactionItems.id })
		.from(transactionItems)
		.where(eq(transactionItems.transactionId, transactionId));
	for (const { id } of itemRows) {
		await exec.delete(transactionItemShares).where(eq(transactionItemShares.itemId, id));
	}
	await exec.delete(transactionItems).where(eq(transactionItems.transactionId, transactionId));
	await exec.delete(transactionCharges).where(eq(transactionCharges.transactionId, transactionId));
	await exec.delete(transactionShares).where(eq(transactionShares.transactionId, transactionId));
	await exec.delete(transactionPayers).where(eq(transactionPayers.transactionId, transactionId));
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

/** Build a minimal custom Zod issue for the category guard below. */
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
	/**
	 * The ORIGINAL transaction total, in the ENTRY currency's minor units (§7.6
	 * display: lists/detail show the original amount + currency). For a same-currency
	 * transaction this equals the settlement total.
	 */
	amountTotal: number;
	/** The ENTRY currency the transaction was recorded in — what `amountTotal` is in. */
	currency: CurrencyCode;
	/** Settlement-currency minor units (the canonical total §8 reads). */
	amountTotalSettlement: number;
	/** Group settlement currency code — what `amountTotalSettlement` is denominated in. */
	settlementCurrency: CurrencyCode;
	/** Whether the entry currency differs from the group's settlement currency (§7.6). */
	isForeign: boolean;
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
	filters = {},
	limit
}: {
	userId: string;
	groupId: string;
	filters?: TransactionListFilters;
	/** Cap the number of rows returned (newest first). Omit for no cap. */
	limit?: number;
}): Promise<TransactionListItem[]> {
	await assertGroupAccess(userId, groupId);

	// The group's settlement currency denominates every `amount_total_settlement`
	// (§7.6) — load it once so foreign-currency rows display their settlement
	// equivalent in the group currency, not the entry currency.
	const settlementCurrency = await loadSettlementCurrency(groupId, db);

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

	const baseQuery = db
		.select({
			id: transactions.id,
			type: transactions.type,
			title: transactions.title,
			categoryId: transactions.categoryId,
			categoryName: categories.name,
			categoryIcon: categories.icon,
			amountTotal: transactions.amountTotal,
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

	// Apply caller-supplied cap (e.g. the overview page requests only 5).
	const rows = limit !== undefined ? await baseQuery.limit(limit) : await baseQuery;

	// `currency` is the ENTRY currency the row was recorded in (§7.6); it may differ
	// from the group's `settlementCurrency`, which is what `amountTotalSettlement` is
	// always denominated in. The list surfaces BOTH so the UI can show the original
	// amount + currency with the settlement equivalent as secondary text (§7.6 display).
	return rows.map((r) => {
		const entryCurrency = r.currency as CurrencyCode;
		return {
			id: r.id,
			type: r.type as 'spending' | 'transfer',
			title: r.title,
			categoryId: r.categoryId,
			categoryName: r.categoryName,
			categoryIcon: r.categoryIcon,
			amountTotal: r.amountTotal,
			currency: entryCurrency,
			amountTotalSettlement: r.amountTotalSettlement,
			settlementCurrency,
			isForeign: entryCurrency !== settlementCurrency,
			createdAt: r.createdAt.toISOString()
		};
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction detail (view + edit seed) — task 4.11 (PLAN §7.1, §7.2, §7.6, §9).
// ─────────────────────────────────────────────────────────────────────────────

/** One resolved per-member settlement share for the view (member id + owed). */
export interface DetailShare {
	readonly memberId: string;
	/** Resolved owed, SETTLEMENT-currency minor units (the §8 source of truth). */
	readonly amountOwed: number;
}

/** One payer line for the view (member id + paid, in the txn's entry currency). */
export interface DetailPayer {
	readonly memberId: string;
	/** Paid, in the TXN entry currency minor units (§7.6). */
	readonly amountPaid: number;
}

/** One itemized line for the view: the item + its per-member resolved owed (txn currency). */
export interface DetailItem {
	readonly label: string;
	/** Item amount, txn-currency minor units. */
	readonly amount: number;
	readonly splitMode: 'equal' | 'amount' | 'share';
	readonly shares: DetailShare[];
}

/** One charge line for the view (raw inputs §7.2.2; the signed effect is derived in the UI). */
export interface DetailCharge {
	readonly kind: 'service' | 'vat' | 'discount' | 'tip';
	readonly mode: 'percent' | 'absolute';
	readonly value: number;
	readonly base: 'items_subtotal' | 'running_total';
	readonly sortOrder: number;
}

/**
 * The full transaction detail (PLAN §7.1, §7.2, §7.6, §9) — enough to BOTH render
 * the view page AND seed the edit form. `input` is the reconstructed
 * {@link TransactionInput} (re-derived from the persisted INPUT columns the create
 * path deliberately stored: `share_weight`/`raw_amount`, per-item `split_mode`,
 * charges, `currency`/`exchange_rate`), so an edit reproduces the exact original
 * form input (§7.2/§7.6 faithful re-edit). A SOFT-DELETED txn is still returned
 * (so it can be restored) with `deletedAt` set.
 */
export interface TransactionDetail {
	readonly id: string;
	readonly groupId: string;
	readonly type: 'spending' | 'transfer';
	readonly title: string;
	readonly categoryId: string;
	readonly categoryName: string;
	readonly categoryIcon: string;
	/** The ORIGINAL total, ENTRY-currency minor units (§7.6 display). */
	readonly amountTotal: number;
	/** The ENTRY currency the txn was recorded in. */
	readonly currency: CurrencyCode;
	/** Settlement-currency minor units (the canonical total §8 reads). */
	readonly amountTotalSettlement: number;
	/** Group settlement currency — what `amountTotalSettlement` / shares are in. */
	readonly settlementCurrency: CurrencyCode;
	/** Whether the entry currency differs from settlement (§7.6). */
	readonly isForeign: boolean;
	readonly splitMode: 'equal' | 'amount' | 'share' | 'itemized';
	/** The real-world date (§7.1 `created_at`), ISO string. */
	readonly createdAt: string;
	/** Soft-delete time (§9), ISO string, or null when live. */
	readonly deletedAt: string | null;
	/** Payer lines (entry currency), for the view. */
	readonly payers: DetailPayer[];
	/** Per-member resolved SETTLEMENT shares (§8 source of truth), for the view. */
	readonly shares: DetailShare[];
	/** Itemized lines (empty for non-itemized), for the view. */
	readonly items: DetailItem[];
	/** Charge lines (empty when none), for the view. */
	readonly charges: DetailCharge[];
	/**
	 * The reconstructed {@link TransactionInput} — re-validates byte-identically to
	 * the original and seeds the edit form (§7.2/§7.6 faithful re-edit).
	 */
	readonly input: TransactionInput;
}

/**
 * Load a transaction's full detail (PLAN §7.1, §7.2, §7.6, §9) — access-checked —
 * for the view page AND the edit-form seed. Reads the `transactions` row + its
 * payers / shares / items / item-shares / charges, then RECONSTRUCTS the original
 * {@link TransactionInput} from the deliberately-persisted input columns so an edit
 * reproduces the exact form input (§7.2/§7.6). A SOFT-DELETED txn is still returned
 * (marked via `deletedAt`) so it can be restored.
 *
 * @throws {GroupAccessError} (→404) when the user can't access the group.
 * @throws {TransactionNotFoundError} (→404) when the id isn't a txn IN this group
 *   (existence never leaked — a txn in another group is indistinguishable from one
 *   that doesn't exist, PLAN §12).
 */
export async function getTransactionDetail({
	userId,
	groupId,
	txnId
}: {
	userId: string;
	groupId: string;
	txnId: string;
}): Promise<TransactionDetail> {
	await assertGroupAccess(userId, groupId);

	const settlementCurrency = await loadSettlementCurrency(groupId, db);

	// The txn row — SCOPED to this group (a txn in another group → not-found, never
	// leaked). Soft-deleted rows ARE returned here (so they can be restored).
	const [txn] = await db
		.select({
			id: transactions.id,
			groupId: transactions.groupId,
			type: transactions.type,
			title: transactions.title,
			categoryId: transactions.categoryId,
			amountTotal: transactions.amountTotal,
			currency: transactions.currency,
			exchangeRate: transactions.exchangeRate,
			amountTotalSettlement: transactions.amountTotalSettlement,
			splitMode: transactions.splitMode,
			createdAt: transactions.createdAt,
			deletedAt: transactions.deletedAt
		})
		.from(transactions)
		.where(and(eq(transactions.id, txnId), eq(transactions.groupId, groupId)))
		.limit(1);

	if (!txn) {
		throw new TransactionNotFoundError();
	}

	const category = getCategory(txn.categoryId);

	// Payers (entry currency `amount_paid`), ordered by member for determinism.
	const payerRows = await db
		.select({ memberId: transactionPayers.memberId, amountPaid: transactionPayers.amountPaid })
		.from(transactionPayers)
		.where(eq(transactionPayers.transactionId, txnId))
		.orderBy(asc(transactionPayers.memberId));

	// Aggregated shares (SETTLEMENT owed — §8 source of truth) + the preserved
	// non-itemized inputs (`share_weight` / `raw_amount`) used to reconstruct the input.
	const shareRows = await db
		.select({
			memberId: transactionShares.memberId,
			amountOwed: transactionShares.amountOwed,
			shareWeight: transactionShares.shareWeight,
			rawAmount: transactionShares.rawAmount
		})
		.from(transactionShares)
		.where(eq(transactionShares.transactionId, txnId))
		.orderBy(asc(transactionShares.memberId));

	// Items (ordered by sort_order, the application order) + their per-item shares
	// (carrying the per-item split_mode + inputs for reconstruction).
	const itemRows = await db
		.select({
			id: transactionItems.id,
			label: transactionItems.label,
			amount: transactionItems.amount,
			sortOrder: transactionItems.sortOrder
		})
		.from(transactionItems)
		.where(eq(transactionItems.transactionId, txnId))
		.orderBy(asc(transactionItems.sortOrder));

	const itemShareRows = itemRows.length
		? await db
				.select({
					itemId: transactionItemShares.itemId,
					memberId: transactionItemShares.memberId,
					amountOwed: transactionItemShares.amountOwed,
					splitMode: transactionItemShares.splitMode,
					shareWeight: transactionItemShares.shareWeight,
					rawAmount: transactionItemShares.rawAmount
				})
				.from(transactionItemShares)
				// Scope to THIS txn's items only (the table keys on `item_id`, not
				// `transaction_id`), so we never read another transaction's item shares.
				.where(
					inArray(
						transactionItemShares.itemId,
						itemRows.map((i) => i.id)
					)
				)
				.orderBy(asc(transactionItemShares.memberId))
		: [];

	const chargeRows = await db
		.select({
			kind: transactionCharges.kind,
			mode: transactionCharges.mode,
			value: transactionCharges.value,
			base: transactionCharges.base,
			sortOrder: transactionCharges.sortOrder
		})
		.from(transactionCharges)
		.where(eq(transactionCharges.transactionId, txnId))
		.orderBy(asc(transactionCharges.sortOrder));

	const entryCurrency = txn.currency as CurrencyCode;
	const splitMode = txn.splitMode as TransactionDetail['splitMode'];
	const isItemized = splitMode === 'itemized';

	// Per-item view + reconstructed item inputs (only for itemized). item-share rows
	// belong to an item via `item_id`; group them per item, in the item's sort order.
	const itemSharesByItem = new Map<string, typeof itemShareRows>();
	for (const row of itemShareRows) {
		const list = itemSharesByItem.get(row.itemId) ?? [];
		list.push(row);
		itemSharesByItem.set(row.itemId, list);
	}

	const detailItems: DetailItem[] = itemRows.map((item) => {
		const shares = itemSharesByItem.get(item.id) ?? [];
		return {
			label: item.label,
			amount: item.amount,
			splitMode: (shares[0]?.splitMode ?? 'equal') as DetailItem['splitMode'],
			shares: shares.map((s) => ({ memberId: s.memberId, amountOwed: s.amountOwed }))
		};
	});

	const detailCharges: DetailCharge[] = chargeRows.map((c) => ({
		kind: c.kind as DetailCharge['kind'],
		mode: c.mode as DetailCharge['mode'],
		value: c.value,
		base: c.base as DetailCharge['base'],
		sortOrder: c.sortOrder
	}));

	// RECONSTRUCT the TransactionInput (§7.2/§7.6 faithful re-edit). For non-itemized
	// the beneficiaries carry the preserved per-mode input: `share_weight` for share,
	// `raw_amount` for amount, neither for equal. For itemized the items carry their
	// own per-item inputs + the charges; top-level beneficiaries are empty.
	const beneficiaries = isItemized
		? []
		: shareRows.map((s) => ({
				memberId: s.memberId,
				...(splitMode === 'share' && s.shareWeight != null ? { shareWeight: s.shareWeight } : {}),
				...(splitMode === 'amount' && s.rawAmount != null ? { rawAmount: s.rawAmount } : {})
			}));

	const inputItems = detailItems.map((item, i) => {
		const rawShares = itemSharesByItem.get(itemRows[i].id) ?? [];
		return {
			label: item.label,
			amount: item.amount,
			splitMode: item.splitMode,
			beneficiaries: rawShares.map((s) => ({
				memberId: s.memberId,
				...(item.splitMode === 'share' && s.shareWeight != null
					? { shareWeight: s.shareWeight }
					: {}),
				...(item.splitMode === 'amount' && s.rawAmount != null ? { rawAmount: s.rawAmount } : {})
			}))
		};
	});

	const input: TransactionInput = {
		type: txn.type as 'spending' | 'transfer',
		title: txn.title,
		// The editable real-world date (§7.1) as a `YYYY-MM-DD` day — seeds the edit
		// form's date picker. `created_at` is stored at noon UTC, so the UTC day is
		// the picked day.
		date: txn.createdAt.toISOString().slice(0, 10),
		categoryId: txn.categoryId,
		amountTotal: txn.amountTotal,
		currency: entryCurrency,
		// Drizzle returns numeric as a string; the schema's exchangeRate is a string.
		exchangeRate: String(txn.exchangeRate),
		amountTotalSettlement: txn.amountTotalSettlement,
		splitMode,
		payers: payerRows.map((p) => ({ memberId: p.memberId, amountPaid: p.amountPaid })),
		beneficiaries,
		items: inputItems,
		charges: detailCharges.map((c) => ({
			kind: c.kind,
			mode: c.mode,
			value: c.value,
			base: c.base,
			sortOrder: c.sortOrder
		}))
	};

	return {
		id: txn.id,
		groupId: txn.groupId,
		type: txn.type as 'spending' | 'transfer',
		title: txn.title,
		categoryId: txn.categoryId,
		categoryName: category?.name ?? txn.categoryId,
		categoryIcon: category?.icon ?? 'circle',
		amountTotal: txn.amountTotal,
		currency: entryCurrency,
		amountTotalSettlement: txn.amountTotalSettlement,
		settlementCurrency,
		isForeign: entryCurrency !== settlementCurrency,
		splitMode,
		createdAt: txn.createdAt.toISOString(),
		deletedAt: txn.deletedAt ? txn.deletedAt.toISOString() : null,
		payers: payerRows.map((p) => ({ memberId: p.memberId, amountPaid: p.amountPaid })),
		shares: shareRows.map((s) => ({ memberId: s.memberId, amountOwed: s.amountOwed })),
		items: detailItems,
		charges: detailCharges,
		input
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit / soft-delete / restore — task 4.11 (PLAN §7.1, §9, §12.1).
// ─────────────────────────────────────────────────────────────────────────────

/** Read a txn's (group, title, soft-delete state) on `exec`, scoped to `groupId`. */
async function loadTransactionForMutation(
	exec: DbExecutor,
	groupId: string,
	txnId: string
): Promise<{ title: string; deletedAt: Date | null }> {
	const [row] = await exec
		.select({ title: transactions.title, deletedAt: transactions.deletedAt })
		.from(transactions)
		.where(and(eq(transactions.id, txnId), eq(transactions.groupId, groupId)))
		.limit(1);
	if (!row) {
		throw new TransactionNotFoundError();
	}
	return { title: row.title, deletedAt: row.deletedAt };
}

/**
 * Edit a transaction in place (PLAN §7.1, §7.2, §7.6, §12.1). Access-checked.
 * REFUSES to edit a soft-deleted txn (restore first) via {@link TransactionDeletedError}.
 *
 * Flow (ONE `db.transaction`): assert access → load the txn (scoped to the group;
 * not-found / wrong-group → 404; soft-deleted → refuse) → RE-VALIDATE the input with
 * the shared schema rebuilt from the group's settlement currency + active member ids
 * → assert the category exists → DELETE this txn's existing child rows → RE-RESOLVE +
 * UPDATE the `transactions` row (keep `id` + immutable `occurred_at`; `created_at`
 * from the validated user date; bump `updated_at`) + RE-INSERT the freshly-resolved
 * child rows (the shared {@link resolveAndWriteTransaction} engine create also uses,
 * so the edit re-resolves identically and never trusts client settlement values) →
 * write the `edit` audit row (metadata carries before→after of key fields).
 *
 * @throws {GroupAccessError} (→404) no access.
 * @throws {TransactionNotFoundError} (→404) not a txn in this group.
 * @throws {TransactionDeletedError} the txn is soft-deleted (must restore first).
 * @throws {TransactionValidationError} the input fails the shared schema.
 */
export async function updateTransaction({
	userId,
	groupId,
	txnId,
	input,
	actorUserId,
	settlementCurrency,
	now = () => new Date()
}: {
	userId: string;
	groupId: string;
	txnId: string;
	/** The RAW, parsed-to-minor-units input (client already ran `parseAmount`). */
	input: unknown;
	/** The user performing the edit (durable audit authorship). Defaults to `userId`. */
	actorUserId?: string;
	/** Group settlement currency (trusted group context, NEVER the payload). */
	settlementCurrency?: CurrencyCode;
	/** Injectable clock (tests). */
	now?: () => Date;
}): Promise<void> {
	const actor = actorUserId ?? userId;
	await db.transaction(async (tx) => {
		await assertGroupAccess(userId, groupId, tx);

		const existing = await loadTransactionForMutation(tx, groupId, txnId);
		// Refuse to edit a soft-deleted txn — it must be restored first (§9). Checked
		// AFTER access + existence so the error never leaks a txn the user can't see.
		if (existing.deletedAt !== null) {
			throw new TransactionDeletedError();
		}

		const currency = settlementCurrency ?? (await loadSettlementCurrency(groupId, tx));

		const memberIds = await activeMemberIds(groupId, tx);
		const schema = buildTransactionSchema({ settlementCurrency: currency, memberIds });
		const parsed = schema.safeParse(input);
		if (!parsed.success) {
			throw new TransactionValidationError(parsed.error.issues);
		}
		const data = parsed.data;

		await assertCategoryExists(data.categoryId, tx);

		// Replace children: delete the existing payer / share / item / item-share /
		// charge rows, then the shared engine re-inserts the freshly-resolved ones and
		// UPDATES the txn row in place (keeping the immutable `occurred_at`).
		await deleteTransactionChildren(tx, txnId);
		const { amountTotalSettlement } = await resolveAndWriteTransaction(tx, {
			mode: 'edit',
			transactionId: txnId,
			groupId,
			userId,
			settlementCurrency: currency,
			data,
			now
		});

		// `edit` audit row — IN THE SAME TRANSACTION (PLAN §12.1). Summary + before→after
		// of key fields (title / amount), in the entry currency (settlement appended when foreign).
		const entryCurrency = data.currency as CurrencyCode;
		const isForeign = entryCurrency !== currency;
		const amountSummary = isForeign
			? `${formatAmount(data.amountTotal, entryCurrency)} (${formatAmount(amountTotalSettlement, currency)})`
			: formatAmount(data.amountTotal, entryCurrency);
		await writeAuditLog(tx, {
			groupId,
			actorUserId: actor,
			action: 'edit',
			entityType: 'transaction',
			entityId: txnId,
			summary: `Edited ${data.type} '${data.title}' — ${amountSummary}`,
			metadata: {
				before: { title: existing.title },
				after: {
					title: data.title,
					amountTotal: data.amountTotal,
					currency: entryCurrency,
					amountTotalSettlement,
					settlementCurrency: currency,
					splitMode: data.splitMode
				}
			}
		});
	});
}

/**
 * Soft-delete a transaction (PLAN §9, §12.1) — set `deleted_at = now()`, guarded by
 * `isNull(deleted_at)` so it is IDEMPOTENT (a no-op on an already-deleted txn rather
 * than overwriting the original delete time). Access-checked; writes a `delete`
 * audit row IN THE SAME `db.transaction` (the audit trail is append-only and
 * OUTLIVES the soft-delete — the row is never removed). Mirrors `softDeleteGroup`.
 *
 * @throws {GroupAccessError} (→404) no access.
 * @throws {TransactionNotFoundError} (→404) not a txn in this group.
 */
export async function softDeleteTransaction({
	userId,
	groupId,
	txnId,
	actorUserId,
	now = () => new Date()
}: {
	userId: string;
	groupId: string;
	txnId: string;
	actorUserId?: string;
	now?: () => Date;
}): Promise<void> {
	const actor = actorUserId ?? userId;
	await db.transaction(async (tx) => {
		await assertGroupAccess(userId, groupId, tx);
		const existing = await loadTransactionForMutation(tx, groupId, txnId);

		// Only stamp `deleted_at` if still null → idempotent (no-op on an already
		// soft-deleted txn; keeps the original delete time + audit history).
		await tx
			.update(transactions)
			.set({ deletedAt: now() })
			.where(and(eq(transactions.id, txnId), isNull(transactions.deletedAt)));

		await writeAuditLog(tx, {
			groupId,
			actorUserId: actor,
			action: 'delete',
			entityType: 'transaction',
			entityId: txnId,
			summary: `Deleted transaction '${existing.title}'`,
			metadata: { title: existing.title }
		});
	});
}

/**
 * Restore a soft-deleted transaction (PLAN §9, §12.1) — clear `deleted_at`, guarded
 * by `isNotNull(deleted_at)` so restoring a LIVE txn is a no-op. Non-destructive (no
 * confirmation needed). Access-checked; writes a `restore` audit row IN THE SAME
 * `db.transaction`.
 *
 * @throws {GroupAccessError} (→404) no access.
 * @throws {TransactionNotFoundError} (→404) not a txn in this group.
 */
export async function restoreTransaction({
	userId,
	groupId,
	txnId,
	actorUserId
}: {
	userId: string;
	groupId: string;
	txnId: string;
	actorUserId?: string;
}): Promise<void> {
	const actor = actorUserId ?? userId;
	await db.transaction(async (tx) => {
		await assertGroupAccess(userId, groupId, tx);
		const existing = await loadTransactionForMutation(tx, groupId, txnId);

		// Only clear if currently deleted → no-op on a live txn.
		await tx
			.update(transactions)
			.set({ deletedAt: null })
			.where(and(eq(transactions.id, txnId), isNotNull(transactions.deletedAt)));

		await writeAuditLog(tx, {
			groupId,
			actorUserId: actor,
			action: 'restore',
			entityType: 'transaction',
			entityId: txnId,
			summary: `Restored transaction '${existing.title}'`,
			metadata: { title: existing.title }
		});
	});
}
