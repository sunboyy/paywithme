// Custom-currency service — the testable business logic that owns GROUP-DEFINED
// currencies (issue #61; PLAN §7.5.2, §12, §12.1; ADR-0014). CLAUDE.md:
// "Business logic in lib/server/".
//
// This is the SERVER-SIDE SERVICE LAYER only — NOT routes/pages. The create/edit
// UI is #62, wiring the group's allowed entry-currency set into the transaction
// form is #63, and mapping `display_code` onto the API / agent read surfaces is
// #64 (`lib/server/entry-currency.ts`, which resolves a transaction's stored code
// for those surfaces without going through this module's access-checked list).
// Mirrors `groups.ts` / `members.ts`: an acting `userId` on every operation,
// `db.transaction(...)` around every mutation, `writeAuditLog(tx, …)` through the
// SAME handle.
//
// ── A custom currency is an ENTRY currency, never a settlement currency ───────
// ADR-0014 decision 1. There is deliberately NO path in this module that writes
// `groups.settlement_currency` — it does not import `groups-schema`'s `groups`
// table for writing at all, and `currencyCodeSchema` (`$lib/schemas/currency`)
// keeps guarding that column from the group service. Every amount §8 reads
// therefore stays denominated in one of the seeded 29, and balances / settle-up /
// the §6.4 lock are untouched by anything here.
//
// ── The opaque code is minted HERE ────────────────────────────────────────────
// `createCustomCurrency` never accepts a `code`: it calls
// `generateCustomCurrencyCode()` itself (PLAN §7.5.2 "A custom row's `code` is
// generated, globally unique and opaque"). The caller supplies `displayCode` —
// what the member typed — and nothing else identifies the row.
//
// ── THE IMMUTABILITY LOCK (the load-bearing rule) ─────────────────────────────
// Once ANY transaction references the row, `exponent` and `displayCode` are FROZEN
// (ADR-0014 decision 5); `name` and `symbol` stay editable. A changed exponent
// would silently reinterpret every minor-unit amount already stored against the
// row — the §6.4 hazard in miniature, with the same remedy.
//
// The lock is checked INSIDE the writing transaction, and it takes a ROW LOCK
// first. See `assertNotReferenced` for why a plain read would let a concurrent
// first transaction slip through.
//
// ── Authorization (PLAN §12) ──────────────────────────────────────────────────
// Group membership is the whole authorization boundary — no new permission concept
// (ADR-0014 decision 2). All FOUR operations (including the read) gate on the 3.3
// `userHasGroupAccess` primitive and throw `GroupAccessError` (→ 404) on no access.
// Mutations assert on the SAME `tx` they then write on.

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { db } from './db';
import { currencies, generateCustomCurrencyCode } from './db/currencies-schema';
import { transactions } from './db/transactions-schema';
import { GroupAccessError, userHasGroupAccess } from './groups';
import { writeAuditLog } from './audit';
import { isUniqueViolation } from './db/pg-errors';
import {
	createCustomCurrencySchema,
	updateCustomCurrencySchema,
	type CreateCustomCurrencyInput,
	type UpdateCustomCurrencyInput
} from '$lib/schemas/custom-currency';
import { CURRENCY_CODES, isCustomCurrency } from '$lib/money';

/** A query runner: either the lazy `db` proxy or an open transaction handle. */
type DbExecutor = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>;

/**
 * The requested display code is already taken (PLAN §7.5.2 "unique within the
 * group"). `conflictsWith` says WHICH — the message must, because the two cases
 * have different fixes: a seeded clash means "that currency already exists, just
 * pick it", a custom clash means "your group already defined this one".
 *
 * The seeded arm is a SERVICE rule, not a database one: the `(group_id,
 * display_code)` unique index cannot see it (seeded rows have `group_id IS NULL`,
 * which Postgres treats as distinct). We reject it because
 * `listCurrenciesForGroup` unions both kinds — two rows showing `USD` in one picker
 * is an ambiguity no user can resolve.
 *
 * The route layer maps `code === 'duplicate_display_code'` to a **form error** on
 * the display-code field (409-ish for the API).
 */
export class DuplicateDisplayCodeError extends Error {
	readonly code = 'duplicate_display_code' as const;
	constructor(
		readonly displayCode: string,
		readonly conflictsWith: 'seeded' | 'custom'
	) {
		super(
			conflictsWith === 'seeded'
				? `${displayCode} is already a supported currency — choose it from the list instead`
				: `This group already has a currency with the code ${displayCode}`
		);
		this.name = 'DuplicateDisplayCodeError';
	}
}

/**
 * A frozen field was asked to change on a currency a transaction already references
 * (ADR-0014 decision 5). `fields` names exactly which of `displayCode` / `exponent`
 * were refused so the form can mark them, and the message says why in the user's
 * terms. The route layer maps `code === 'currency_immutable'` to **409 Conflict**,
 * consistent with `CurrencyLockedError` for the §6.4 settlement-currency lock.
 */
export class CurrencyImmutableError extends Error {
	readonly code = 'currency_immutable' as const;
	constructor(
		readonly displayCode: string,
		readonly fields: readonly ('displayCode' | 'exponent')[]
	) {
		super(
			`${displayCode} is used by at least one transaction, so its ` +
				`${fields.join(' and ')} can no longer be changed`
		);
		this.name = 'CurrencyImmutableError';
	}
}

/**
 * Delete refused: at least one transaction is recorded in this currency (PLAN
 * §7.5.2 — permitted only while unreferenced). Removing it would break
 * `transactions.currency → currencies.code` and leave stored amounts with no
 * exponent to interpret them by. The route layer maps `code ===
 * 'currency_in_use'` to **409 Conflict**.
 */
export class CurrencyInUseError extends Error {
	readonly code = 'currency_in_use' as const;
	constructor(readonly displayCode: string) {
		super(`${displayCode} is used by at least one transaction and cannot be deleted`);
		this.name = 'CurrencyInUseError';
	}
}

/**
 * No CUSTOM currency with that code in this group. Also the answer for "that code
 * belongs to another group" and for "that's one of the seeded 29" — a seeded row is
 * not this group's to edit or delete, and conflating the three is the same
 * don't-leak discipline `GroupAccessError` applies to groups (PLAN §12). Route
 * layer → **404**.
 */
export class CurrencyNotFoundError extends Error {
	readonly code = 'currency_not_found' as const;
	constructor(message = 'Currency not found') {
		super(message);
		this.name = 'CurrencyNotFoundError';
	}
}

/** A `currencies` row as stored — structurally a `CurrencyDescriptor` already. */
export type CurrencyRow = typeof currencies.$inferSelect;

/**
 * One entry in a group's currency list: the stored row plus the one thing every
 * caller re-derives otherwise. `isCustom` is read off the `code != display_code`
 * invariant (`$lib/money`'s `isCustomCurrency`), never off `group_id`, so it means
 * the same thing here as it does in the formatter.
 */
export type GroupCurrency = CurrencyRow & { isCustom: boolean };

/**
 * Assert access or throw `GroupAccessError` (→ 404) — the single §12 membership
 * check, applied to all four operations. Thin wrapper over the 3.3 primitive so
 * "no access" and "no such group" stay one indistinguishable outcome.
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

/** Canonical position of each seeded code, so the list keeps PLAN §7.5.1 order. */
const SEEDED_ORDER = new Map(CURRENCY_CODES.map((code, i) => [code as string, i]));

/**
 * Load THIS GROUP's custom row by its opaque code, or throw `CurrencyNotFoundError`.
 *
 * Two guards in one query, both load-bearing:
 *   - `group_id = groupId` is the cross-group guard AND the seeded-row guard (a
 *     seeded row has `group_id IS NULL`, so it can never match) — the mutations
 *     physically cannot touch another group's currency or one of the 29.
 *   - `FOR UPDATE` takes the row lock the immutability check depends on; see
 *     {@link assertNotReferenced}.
 */
async function getGroupCurrencyForUpdate(
	groupId: string,
	code: string,
	executor: DbExecutor
): Promise<CurrencyRow> {
	const [row] = await executor
		.select()
		.from(currencies)
		.where(and(eq(currencies.code, code), eq(currencies.groupId, groupId)))
		.limit(1)
		.for('update');

	if (!row) {
		throw new CurrencyNotFoundError();
	}
	return row;
}

/**
 * Return the requested currency codes referenced by ANY transaction.
 *
 * This is the one shared definition used by both the mutation lock below and the
 * advisory settings read in `currency-usage.ts`. It deliberately has no
 * `deleted_at IS NULL` filter: a soft-deleted transaction still stores amounts in
 * this currency and can be restored (PLAN §9), so its exponent must keep meaning
 * what it meant. The caller chooses the strength: mutations pass their open
 * transaction after locking the currency row; the UI read uses the default DB
 * handle and remains advisory.
 *
 * One grouped query handles every requested code, avoiding a query per custom
 * currency on the settings page.
 */
export async function findReferencedCurrencyCodes(
	codes: readonly string[],
	executor: DbExecutor = db
): Promise<Set<string>> {
	if (codes.length === 0) return new Set();

	const rows = await executor
		.select({ currency: transactions.currency })
		.from(transactions)
		.where(inArray(transactions.currency, codes))
		.groupBy(transactions.currency);

	return new Set(rows.map((row) => row.currency));
}

/** Is this one currency referenced, using the shared definition above? */
async function isReferencedByTransaction(code: string, executor: DbExecutor): Promise<boolean> {
	return (await findReferencedCurrencyCodes([code], executor)).size > 0;
}

/**
 * THE IMMUTABILITY LOCK, checked atomically (ADR-0014 decision 5).
 *
 * Why this is not just a read. The dangerous interleaving is: someone records the
 * FIRST transaction in `BEER` while someone else edits its exponent. If the edit
 * checks "is it referenced?" in an earlier, separate statement — or worse, in a
 * prior request — it sees "no" and proceeds, and the two commits together produce
 * exactly the outcome the rule exists to prevent: a stored amount interpreted with
 * an exponent it was never entered under.
 *
 * How this half closes it. The caller has already taken `FOR UPDATE` on the
 * `currencies` row (see {@link getGroupCurrencyForUpdate}), in the SAME transaction
 * as the write, and the reference read below runs while that lock is held. An
 * explicit `FOR UPDATE` is REQUIRED: updating only `exponent` / `display_code`
 * touches no key column, so the update's own row lock would be `FOR NO KEY UPDATE`,
 * which does NOT conflict with the `FOR KEY SHARE` an inserting transaction takes
 * on the parent currency row through the `transactions.currency → currencies.code`
 * foreign key — the two could then commit concurrently.
 *
 * ── The half that is NOT ours (issue #69 finding 1) ───────────────────────────
 * This docstring used to argue the race was fully closed HERE, by `FOR UPDATE`
 * conflicting with the FK's `FOR KEY SHARE` at the inserter's insert. That analysis
 * assumed the inserter's READ of the exponent and its INSERT were atomic, and they
 * are not: the exponent is read when the write transaction resolves its
 * entry-currency allow-list, and the referencing row is inserted much later in the
 * same transaction. With an UNLOCKED read the interleaving
 *   T1 reads exponent 2 → T2 takes an UNCONTENDED `FOR UPDATE`, sees no reference,
 *   commits exponent 0 → T1 inserts (its `FOR KEY SHARE` now conflicts with nothing)
 * commits both, and the amount is stored at a scale it was never entered under.
 *
 * The fix is on the READER's side and lives in `transactions.ts`:
 * `resolveEntryCurrencies` takes `FOR SHARE` when it reads the group's custom rows,
 * in the write's own transaction, and holds it through the insert. THAT is what our
 * `FOR UPDATE` conflicts with, and only together do the two guarantee:
 *   - if the write got its `FOR SHARE` first, our `FOR UPDATE` BLOCKS until it
 *     commits or rolls back; when it commits, the read below (a fresh statement
 *     snapshot under READ COMMITTED) SEES its row and we refuse the edit;
 *   - if we got there first, the write's `FOR SHARE` blocks on us and it reads the
 *     exponent we committed — the amount is entered under the exponent it will be
 *     read with.
 * Weakening either lock re-opens the window; they are one mechanism in two files.
 */
async function assertNotReferenced(
	row: CurrencyRow,
	fields: readonly ('displayCode' | 'exponent')[],
	executor: DbExecutor
): Promise<void> {
	if (fields.length === 0) return;
	if (await isReferencedByTransaction(row.code, executor)) {
		throw new CurrencyImmutableError(row.displayCode, fields);
	}
}

/**
 * Reject a display code that is already taken, saying WHICH kind it clashes with
 * (PLAN §7.5.2). One query covers both arms: seeded rows (`group_id IS NULL`) and
 * this group's own custom rows. Runs on the caller's `tx` so it is part of the same
 * unit of work as the insert/update it guards; the `(group_id, display_code)`
 * unique index is still the final authority under a race (see the callers'
 * `isUniqueViolation` mapping).
 *
 * `excludeCode` skips the row being edited, so re-submitting a currency's own
 * display code is never a "duplicate".
 */
async function assertDisplayCodeAvailable(
	groupId: string,
	displayCode: string,
	executor: DbExecutor,
	excludeCode?: string
): Promise<void> {
	const clashes = await executor
		.select({ code: currencies.code, groupId: currencies.groupId })
		.from(currencies)
		.where(
			and(
				eq(currencies.displayCode, displayCode),
				or(isNull(currencies.groupId), eq(currencies.groupId, groupId))
			)
		);

	for (const clash of clashes) {
		if (clash.code === excludeCode) continue;
		throw new DuplicateDisplayCodeError(displayCode, clash.groupId === null ? 'seeded' : 'custom');
	}
}

/**
 * Every currency this group may use as a transaction's ENTRY currency (PLAN
 * §7.5.2): the 29 seeded rows PLUS this group's own custom rows, and no other
 * group's. This is the single set the entry-currency picker (#62/#63) renders and
 * the group-scoped entry-currency validator (#63) checks against — one function, so
 * the two can never disagree about what is allowed.
 *
 * Access-checked (§12). Ordered seeded-first in PLAN §7.5.1 rank order, then the
 * group's custom rows alphabetically by display code — a stable order the picker can
 * render as-is.
 */
export async function listCurrenciesForGroup({
	userId,
	groupId
}: {
	userId: string;
	groupId: string;
}): Promise<GroupCurrency[]> {
	await assertGroupAccess(userId, groupId);

	const rows = await db
		.select()
		.from(currencies)
		.where(or(isNull(currencies.groupId), eq(currencies.groupId, groupId)));

	return rows
		.map((row) => ({ ...row, isCustom: isCustomCurrency(row) }))
		.sort((a, b) => {
			// Seeded block first, in the canonical §7.5.1 order.
			if (a.isCustom !== b.isCustom) return a.isCustom ? 1 : -1;
			if (!a.isCustom) {
				return (SEEDED_ORDER.get(a.code) ?? 0) - (SEEDED_ORDER.get(b.code) ?? 0);
			}
			return a.displayCode.localeCompare(b.displayCode);
		});
}

/**
 * Define a new custom currency for a group (PLAN §7.5.2). Validates the input
 * through the shared schema (so the code arrives trimmed + uppercased), then, in
 * ONE transaction: asserts membership, rejects a duplicate display code, inserts
 * the row under a freshly MINTED opaque code, and appends the `audit_log` row.
 *
 * The caller never supplies `code`, `groupId`'s row identity, or `createdBy` — all
 * three are server-derived here.
 */
export async function createCustomCurrency({
	userId,
	groupId,
	input
}: {
	userId: string;
	groupId: string;
	input: CreateCustomCurrencyInput;
}): Promise<CurrencyRow> {
	// Validate at the service boundary too (defense in depth — the route validates
	// with the same schema). Throws ZodError → 400 / form errors at the route.
	const data = createCustomCurrencySchema.parse(input);

	return db.transaction(async (tx) => {
		await assertGroupAccess(userId, groupId, tx);
		await assertDisplayCodeAvailable(groupId, data.displayCode, tx);

		// The opaque PK is minted HERE and never accepted from a caller (§7.5.2).
		const code = generateCustomCurrencyCode();

		let row: CurrencyRow;
		try {
			[row] = await tx
				.insert(currencies)
				.values({
					code,
					displayCode: data.displayCode,
					name: data.name,
					symbol: data.symbol,
					exponent: data.exponent,
					groupId,
					createdBy: userId,
					// No DB-level default (it would have back-stamped the seeded rows) —
					// see `currencies-schema.ts`.
					createdAt: new Date()
				})
				.returning();
		} catch (e) {
			// Lost a race with a concurrent create of the same display code: the
			// `(group_id, display_code)` unique index is the final authority. Surface it
			// as the same user-facing error the pre-check would have produced.
			if (isUniqueViolation(e)) {
				throw new DuplicateDisplayCodeError(data.displayCode, 'custom');
			}
			throw e;
		}

		// Audit row — IN THE SAME TRANSACTION (PLAN §12.1). `entityId` is the opaque
		// code (durable); the summary denormalizes the display code + name so the line
		// stays readable after either is edited or the row is deleted.
		await writeAuditLog(tx, {
			groupId,
			actorUserId: userId,
			action: 'create',
			entityType: 'currency',
			entityId: row.code,
			summary: `Created custom currency '${row.displayCode}' (${row.name})`,
			metadata: {
				displayCode: row.displayCode,
				name: row.name,
				symbol: row.symbol,
				exponent: row.exponent
			}
		});
		return row;
	});
}

/** Which fields an edit actually MOVES (a resubmitted identical value is not a change). */
function changedFields(row: CurrencyRow, data: UpdateCustomCurrencyInput) {
	return {
		displayCode: data.displayCode !== undefined && data.displayCode !== row.displayCode,
		name: data.name !== undefined && data.name !== row.name,
		symbol: data.symbol !== undefined && data.symbol !== row.symbol,
		exponent: data.exponent !== undefined && data.exponent !== row.exponent
	};
}

/**
 * Edit a custom currency (PLAN §7.5.2), ENFORCING THE IMMUTABILITY LOCK.
 *
 * `name` and `symbol` are always editable. `displayCode` and `exponent` may move
 * only while NO transaction references the row; afterwards the attempt is refused
 * with `CurrencyImmutableError` naming the frozen fields (ADR-0014 decision 5).
 * Submitting a frozen field UNCHANGED is not an attempt to change it, so re-posting
 * a full form to rename a locked currency still works.
 *
 * AN EDIT THAT MOVES NOTHING IS A NO-OP. Opening the edit form and pressing Save
 * without touching a field submits every value unchanged; that must not append an
 * `audit_log` row, because the §12.1 feed is an accountability record and a
 * phantom "Edited" line is the trail saying something that didn't happen. The
 * shared schema can only reject an edit whose fields are all ABSENT — value
 * equality needs the stored row, so it is decided here, after the row is loaded.
 * The `currencies` UPDATE is skipped too (it would rewrite identical values).
 *
 * Everything — the membership check, the row load + `FOR UPDATE` lock, the
 * reference check, the write and the audit row — happens in ONE transaction. See
 * {@link assertNotReferenced} for why the reference check must not be a prior read.
 */
export async function updateCustomCurrency({
	userId,
	groupId,
	code,
	input
}: {
	userId: string;
	groupId: string;
	code: string;
	input: UpdateCustomCurrencyInput;
}): Promise<CurrencyRow> {
	const data = updateCustomCurrencySchema.parse(input);

	return db.transaction(async (tx) => {
		await assertGroupAccess(userId, groupId, tx);
		// Scoped to this group (never a seeded row, never another group's) AND locked.
		const before = await getGroupCurrencyForUpdate(groupId, code, tx);

		const changed = changedFields(before, data);
		const moved = (Object.keys(changed) as (keyof typeof changed)[]).filter((f) => changed[f]);

		// NO-OP GUARD (see the docblock): every submitted value equals the stored one,
		// so there is nothing to write and nothing to record. Return the row as-is
		// rather than rewriting it and appending an "Edited" entry that would be false.
		if (moved.length === 0) {
			return before;
		}

		// The lock: only the FROZEN fields that are actually moving are checked, and
		// only against a reference read taken while we hold the row lock.
		const frozen = (['displayCode', 'exponent'] as const).filter((f) => changed[f]);
		await assertNotReferenced(before, frozen, tx);

		if (changed.displayCode && data.displayCode !== undefined) {
			await assertDisplayCodeAvailable(groupId, data.displayCode, tx, before.code);
		}

		// Only ever set the fields the caller submitted — an absent field is "leave it".
		const patch = {
			...(data.displayCode !== undefined ? { displayCode: data.displayCode } : {}),
			...(data.name !== undefined ? { name: data.name } : {}),
			...(data.symbol !== undefined ? { symbol: data.symbol } : {}),
			...(data.exponent !== undefined ? { exponent: data.exponent } : {})
		};

		let updated: CurrencyRow | undefined;
		try {
			[updated] = await tx
				.update(currencies)
				.set(patch)
				.where(and(eq(currencies.code, before.code), eq(currencies.groupId, groupId)))
				.returning();
		} catch (e) {
			if (isUniqueViolation(e)) {
				throw new DuplicateDisplayCodeError(data.displayCode ?? before.displayCode, 'custom');
			}
			throw e;
		}

		if (!updated) {
			// We hold FOR UPDATE on the row, so this is unreachable in practice; treat a
			// vanished row as not-found rather than returning undefined.
			throw new CurrencyNotFoundError();
		}

		// Audit row — IN THE SAME TRANSACTION (PLAN §12.1). The summary names the
		// currency by its display code AFTER the edit and lists what moved; metadata
		// keeps the before/after snapshot so the line survives later changes. `moved`
		// is never empty here — the no-op guard above returned early.
		await writeAuditLog(tx, {
			groupId,
			actorUserId: userId,
			action: 'edit',
			entityType: 'currency',
			entityId: updated.code,
			summary: `Edited custom currency '${updated.displayCode}' — changed ${moved.join(', ')}`,
			metadata: {
				changed: moved,
				before: {
					displayCode: before.displayCode,
					name: before.name,
					symbol: before.symbol,
					exponent: before.exponent
				},
				after: {
					displayCode: updated.displayCode,
					name: updated.name,
					symbol: updated.symbol,
					exponent: updated.exponent
				}
			}
		});
		return updated;
	});
}

/**
 * Delete a custom currency — permitted ONLY while unreferenced (PLAN §7.5.2).
 *
 * A HARD delete, deliberately: an unreferenced definition has no ledger history to
 * preserve (the same reasoning as `removeMember`'s zero-activity branch), and
 * leaving a soft-deleted row behind would keep occupying its `(group_id,
 * display_code)` slot. Once ANY transaction references it, delete is refused with
 * `CurrencyInUseError` — the row must outlive the amounts that depend on it.
 *
 * Unlike that member branch, this one IS audited: a currency definition is a
 * group-visible artefact, and its disappearance must be attributable (§12.1). The
 * row is gone afterwards, so the summary carries the label (`entityId` is the
 * opaque code and may dangle by design — `audit-schema.ts`).
 *
 * The reference check runs under the same `FOR UPDATE` row lock as the edit path,
 * for the same reason: a concurrent first transaction must not slip through.
 */
export async function deleteCustomCurrency({
	userId,
	groupId,
	code
}: {
	userId: string;
	groupId: string;
	code: string;
}): Promise<void> {
	await db.transaction(async (tx) => {
		await assertGroupAccess(userId, groupId, tx);
		const row = await getGroupCurrencyForUpdate(groupId, code, tx);

		if (await isReferencedByTransaction(row.code, tx)) {
			throw new CurrencyInUseError(row.displayCode);
		}

		await tx
			.delete(currencies)
			.where(and(eq(currencies.code, row.code), eq(currencies.groupId, groupId)));

		// Audit row — IN THE SAME TRANSACTION (PLAN §12.1).
		await writeAuditLog(tx, {
			groupId,
			actorUserId: userId,
			action: 'delete',
			entityType: 'currency',
			entityId: row.code,
			summary: `Deleted custom currency '${row.displayCode}' (${row.name})`,
			metadata: {
				displayCode: row.displayCode,
				name: row.name,
				symbol: row.symbol,
				exponent: row.exponent
			}
		});
	});
}
