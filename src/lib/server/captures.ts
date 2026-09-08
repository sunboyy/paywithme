// Capture service — the whole business logic for record-later placeholders
// (issue #49; PLAN §7.7, §9, §12, §12.1; ADR-0012). CLAUDE.md: "Business logic in
// lib/server/".
//
// One way in (`createCapture`), three ways to read (`listOpenCaptures`,
// `countOpenCapturesByGroup`, `findOpenCapture`) and exactly two endings
// (`resolveCapture` / `recordCaptureAsTransaction`, and `discardCapture`). A
// Capture has no edit path and no delete path — it is a note you either record or
// give up on, and both endings are STAMPS on the row, never a row delete, so the
// trail from "I remembered this on Saturday" to "I recorded it on Tuesday"
// survives (§7.7).
//
// ── THE SHALLOWNESS IS THE SPEC (ADR-0012) ───────────────────────────────────
// Nothing here resolves a payer, a beneficiary, a split or a rate, because there
// is nothing of the sort to resolve. `amount_minor` + `currency` are written and
// read back UNCHANGED: no conversion, no settlement equivalent, no exponent
// arithmetic. If a future change makes this module import `lib/money`'s
// conversion helpers or `resolveShares`, that change is building a second
// transaction form and is what ADR-0012 rejects.
//
// ── NEVER IN THE LEDGER (PLAN §7.7) ──────────────────────────────────────────
// §8 balance math, `/settle`, `/api/v1` and the MCP transaction tools do not read
// `captures` — not even as a provisional "±฿1,200 pending" note on a balance. The
// dependency direction proves it: this module imports from `transactions.ts` (to
// verify the transaction a resolve points at, and to CREATE the one a resolve
// records), and nothing in the ledger imports from here. That is also why
// `recordCaptureAsTransaction` lives on this side of the line and reaches into the
// create through a hook, rather than `createTransaction` learning what a Capture
// is.
//
// ── AUTHORIZATION (PLAN §12) ─────────────────────────────────────────────────
// Group-membership only, no per-action roles. Every operation takes the acting
// `userId` and gates on `userHasGroupAccess` FIRST — before it validates input, so
// a non-member learns nothing about a group from the shape of the errors it
// returns. Captures are GROUP-VISIBLE (§7.7): any member may resolve or discard
// any member's Capture, because the point is deduplication — if someone else
// already recorded that dinner, they are the one holding the tray open.
//
// ── AUDIT LOG (PLAN §12.1) ───────────────────────────────────────────────────
// Each of the three mutations runs inside `db.transaction(...)` and calls
// `writeAuditLog(tx, …)` through that SAME `tx` handle (never the global `db`), so
// the audit row commits or rolls back atomically with the mutation. Every
// `summary` denormalizes the note, so the line stays readable after the row
// changes — and none of them contains the word "Capture", which is internal
// vocabulary (CONTEXT.md): they say "not recorded yet".

import { and, count, eq, exists, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db } from './db';
import { captures } from './db/captures-schema';
import { currencies } from './db/currencies-schema';
import { groups, members } from './db/groups-schema';
import { transactions } from './db/transactions-schema';
import { GroupAccessError, userHasGroupAccess } from './groups';
import { createTransaction, TransactionNotFoundError } from './transactions';
import { writeAuditLog, type AuditVia } from './audit';
import { buildCreateCaptureSchema, type CreateCaptureInput } from '$lib/schemas/capture';
import type { EntryCurrencyOption } from '$lib/schemas/currency';
import { CURRENCY_CODES, getCurrency, type SeededCurrencyCode } from '$lib/money';

/** A query runner: either the lazy `db` proxy or an open transaction handle. */
type DbExecutor = Pick<typeof db, 'select' | 'insert' | 'update'>;

/** A stored Capture, exactly as the table holds it. */
export type Capture = typeof captures.$inferSelect;

/**
 * The submitted Capture failed server-side validation (the SAME shared
 * `buildCreateCaptureSchema` the form uses). Carries the Zod issues so the route
 * can surface them on the fields rather than 500-ing. Mirrors
 * `TransactionValidationError`; the route maps `code === 'capture_invalid'` to a
 * form failure, distinct from the 404 an access error produces.
 */
export class CaptureValidationError extends Error {
	readonly code = 'capture_invalid' as const;
	readonly issues: z.core.$ZodIssue[];
	constructor(issues: z.core.$ZodIssue[], message = 'Capture is invalid') {
		super(message);
		this.name = 'CaptureValidationError';
		this.issues = issues;
	}
}

/**
 * No such Capture IN THIS GROUP. A Capture belonging to another group is
 * indistinguishable from one that never existed — the same don't-leak rule §12
 * applies to group existence. The route maps `code === 'capture_not_found'` to
 * **404**.
 */
export class CaptureNotFoundError extends Error {
	readonly code = 'capture_not_found' as const;
	constructor(message = 'Not found') {
		super(message);
		this.name = 'CaptureNotFoundError';
	}
}

/**
 * The Capture exists in this group but has ALREADY been resolved or discarded, so
 * there is nothing left to resolve or discard.
 *
 * This is a real race, not a defensive nicety: the tray is GROUP-VISIBLE (§7.7),
 * so two members can act on the same row at the same time, and the whole point of
 * showing it to everyone is that the second person stops. Reporting it as
 * not-found would tell them their tap worked. `reason` says which ending already
 * happened so the route can word it ("Someone already recorded this"). Mapped to
 * **409 Conflict**.
 */
export class CaptureNotOpenError extends Error {
	readonly code = 'capture_not_open' as const;
	constructor(
		readonly reason: 'resolved' | 'discarded',
		message = reason === 'resolved'
			? 'This has already been recorded'
			: 'This has already been discarded'
	) {
		super(message);
		this.name = 'CaptureNotOpenError';
	}
}

/** Assert access or throw `GroupAccessError` (→ 404). */
async function assertGroupAccess(
	userId: string,
	groupId: string,
	executor: DbExecutor = db
): Promise<void> {
	if (!(await userHasGroupAccess(userId, groupId, executor))) {
		throw new GroupAccessError();
	}
}

/** The 29 seeded codes as the schema factory wants them — built once. */
const SEEDED_CURRENCY_OPTIONS: readonly EntryCurrencyOption[] = CURRENCY_CODES.map((code) => ({
	code
}));

/**
 * The currency codes this group may denominate a Capture in: the 29 seeded codes
 * plus the group's own custom rows (PLAN §7.5.2; ADR-0014).
 *
 * SEEDED FAST PATH — no submitted currency, or a seeded one, issues NO query at
 * all, which is every Capture in every group that never opened the custom-currency
 * UI.
 *
 * NO `FOR SHARE` LOCK, deliberately, and this is the interesting difference from
 * `transactions.ts#resolveEntryCurrencies`. That one locks the custom rows because
 * it reads their EXPONENT and computes stored amounts with it, so an edit landing
 * mid-write would record amounts at the wrong precision. A Capture computes
 * nothing: the amount is stored uninterpreted (§7.7) and the exponent is only ever
 * read later, at render time, from whatever the row says then. There is nothing to
 * freeze, so nothing is locked — and a Capture never makes a currency edit wait.
 */
async function allowedCurrencies(
	groupId: string,
	submitted: unknown,
	executor: DbExecutor
): Promise<readonly EntryCurrencyOption[]> {
	if (typeof submitted !== 'string' || getCurrency(submitted) !== undefined) {
		// Absent, unusable (the schema rejects it against the seeded set with the same
		// message), or seeded — no custom row can be relevant.
		return SEEDED_CURRENCY_OPTIONS;
	}

	const rows = await executor
		.select({ code: currencies.code })
		.from(currencies)
		.where(eq(currencies.groupId, groupId));

	return [...SEEDED_CURRENCY_OPTIONS, ...rows];
}

/**
 * Run the create-Capture gate against the SEEDED currency set ALONE, without
 * opening a database transaction — throwing the same {@link CaptureValidationError}
 * {@link createCapture} throws.
 *
 * For a caller that cannot name a group's CUSTOM currency, this is the identical
 * verdict `createCapture` will reach: {@link allowedCurrencies} widens the set only
 * for a submitted non-seeded code, so an absent or seeded `currency` already makes
 * that query return exactly `SEEDED_CURRENCY_OPTIONS`.
 *
 * That caller is the MCP `create_capture` tool. A group's custom currency lives
 * under an opaque `cur_…` key the agent has never seen and must never be handed
 * (ADR-0014 decision 7), so the tool restricts `currency` to the seeded codes before
 * anything else — and then needs to know whether the call can succeed BEFORE its
 * idempotency guard reserves a key for it, because a rejection raised after that
 * reservation would answer the agent's corrected retry with a phantom
 * `conflict/in_progress` (ADR-0005, ADR-0009).
 *
 * This does NOT replace the parse inside `createCapture`: that one stays the
 * authority, runs for the web route too, and re-checks the same input inside the
 * write's own transaction.
 */
export function parseSeededCaptureInput(input: unknown): CreateCaptureInput {
	const parsed = buildCreateCaptureSchema(SEEDED_CURRENCY_OPTIONS).safeParse(input);
	if (!parsed.success) {
		throw new CaptureValidationError(parsed.error.issues);
	}
	return parsed.data;
}

/** The `currency` value a raw input object carries, if it carries one at all. */
function submittedCurrency(input: unknown): unknown {
	return typeof input === 'object' && input !== null
		? (input as { currency?: unknown }).currency
		: undefined;
}

/**
 * Record a Capture (PLAN §7.7).
 *
 * ONE transaction: membership (§12), then validation against the group's currency
 * set, then the insert, then the `audit_log` row — all four or none of them.
 *
 * `createdBy` and `groupId` are SERVER-DERIVED: the author is the authenticated
 * caller, never a field in `input`, so a Capture can't be attributed to somebody
 * else (attribution is the whole of §7.7's deduplication value).
 */
export async function createCapture({
	userId,
	groupId,
	input,
	via
}: {
	userId: string;
	groupId: string;
	input: unknown;
	/**
	 * Credential provenance (PLAN §16.2) — set when the Capture came in through an
	 * API key or an OAuth connection rather than a web session. ADR-0012 expects the
	 * Connector to be the FASTEST capture path, so this is not a hypothetical.
	 */
	via?: AuditVia;
}): Promise<Capture> {
	return db.transaction(async (tx) => {
		await assertGroupAccess(userId, groupId, tx);

		const allowed = await allowedCurrencies(groupId, submittedCurrency(input), tx);
		const parsed = buildCreateCaptureSchema(allowed).safeParse(input);
		if (!parsed.success) {
			throw new CaptureValidationError(parsed.error.issues);
		}
		const data = parsed.data;

		const [row] = await tx
			.insert(captures)
			.values({
				groupId,
				createdBy: userId,
				note: data.note,
				// Both or neither — the schema's pairing rule already guaranteed it.
				amountMinor: data.amountMinor ?? null,
				currency: data.currency ?? null,
				capturedFor: data.capturedFor
			})
			.returning();

		await writeAuditLog(tx, {
			groupId,
			actorUserId: userId,
			action: 'create',
			entityType: 'capture',
			entityId: row.id,
			summary: `Noted '${row.note}' as not recorded yet`,
			// Denormalized so the entry stays complete even after the row is resolved
			// (which is when the note stops being visible in the tray).
			metadata: {
				note: row.note,
				amountMinor: row.amountMinor,
				currency: row.currency,
				capturedFor: row.capturedFor
			},
			via
		});

		return row;
	});
}

/**
 * A database-less query builder, for the correlated subquery in {@link reopenedArm}.
 * `db` is a lazy proxy and would compile the same SQL, but a predicate is pure SQL
 * and should not have to reach for a connection to say so — and this keeps
 * {@link openCapturePredicate} compilable in a unit test that stubs `db` out.
 */
const qb = new QueryBuilder();

/**
 * ARM 1 of "open" — a note NOBODY HAS STAMPED: `resolved_at IS NULL AND
 * discarded_at IS NULL`.
 *
 * Both nulls matter: a discarded Capture was never resolved, so testing
 * `resolved_at` alone would keep showing (and counting) it forever. This is exactly
 * the partial index `captures_group_id_open_idx` (see `captures-schema.ts`), which
 * is why every reader below applies it as its OWN predicate rather than OR-ing it
 * with arm 2 — an OR'd query can use neither partial index.
 */
function neverStampedArm(): SQL | undefined {
	return and(isNull(captures.resolvedAt), isNull(captures.discardedAt));
}

/**
 * ARM 2 of "open" — a note that WAS recorded, into a transaction that has since
 * been SOFT-DELETED (issue #91).
 *
 * §7.7 is explicit that "resolve is a stamp, not a delete", so a soft delete
 * clears NOTHING here: `resolved_transaction_id` and `resolved_at` still stand, and
 * the audit log still holds every recording. What changes is only what the stamp
 * MEANS while the transaction it points at is deleted — the expense is in no
 * balance, so the note is back to being a thing nobody has recorded, and it belongs
 * in the tray and the count again. Restoring the transaction closes it again, with
 * no write on either side. (A HARD delete is the other case and stays closed: the
 * FK's `set null` leaves `resolved_at` standing with no link, and no link is not a
 * deleted transaction.)
 *
 * `narrowTransactions` is a REDUNDANT qual on the transaction side — the caller's
 * own group filter, restated inside the subquery. It changes no row: a resolve
 * verifies that the transaction is in the Capture's group, so a note in group G can
 * only point into G. It changes the PLAN, which is the whole reason the arm is
 * shaped this way. With it, Postgres drives from `transactions_group_id_deleted_idx`
 * — that group's soft-deleted transactions, usually none — and probes
 * `captures_resolved_transaction_id_idx` for the note pointing at each. Without it,
 * it reads every note in the group and tests them one by one, which is the scan the
 * partial index exists to prevent. Omit it only where there is nothing to narrow
 * (a lookup by capture id, which is a primary-key hit anyway).
 */
function reopenedArm(narrowTransactions?: SQL): SQL | undefined {
	return and(
		isNull(captures.discardedAt),
		exists(
			qb
				.select({ one: sql`1` })
				.from(transactions)
				.where(
					and(
						eq(transactions.id, captures.resolvedTransactionId),
						isNotNull(transactions.deletedAt),
						narrowTransactions
					)
				)
		)
	);
}

/**
 * "Open" — the ONE definition of what the tray shows and what the unrecorded count
 * counts: {@link neverStampedArm} OR {@link reopenedArm}.
 *
 * The two arms are DISJOINT (arm 1 has no `resolved_at`, arm 2 must have one), so a
 * reader may take them together as this predicate or run them as two queries and
 * concatenate — the answer is the same either way, and no row is counted twice.
 * Which shape a reader picks is a question about indexes, not about meaning: this
 * OR'd form is for reading ONE row by id (a primary-key hit, where the plan is
 * settled before the predicate is looked at), and the tray and the count use the
 * arms separately so each keeps its index.
 *
 * Exported so the recall surfaces (§7.7) can be proved to share one definition
 * rather than to agree by inspection: a tray and a count that disagree is a badge
 * saying "3" over a list of two.
 */
export function openCapturePredicate(): SQL | undefined {
	return or(neverStampedArm(), reopenedArm());
}

/**
 * Newest first, mirroring the SQL the tray used when "open" was a single indexed
 * predicate: real-world day, then the moment the note was written, then `id` as the
 * tie-break that keeps the order stable across reads.
 *
 * In JS because the tray now reads its two arms as two queries; sorting their
 * concatenation here is one ordering rule for both, where an `ORDER BY` repeated
 * per arm plus a merge would be two. The tray is a queue to empty — its whole
 * length is already in memory, and always was.
 *
 * A re-opened note therefore returns to its OWN place in the tray (its
 * `captured_for`), not to the top: the day the expense happened has not changed.
 */
function newestFirst(a: Capture, b: Capture): number {
	if (a.capturedFor !== b.capturedFor) return a.capturedFor < b.capturedFor ? 1 : -1;
	const byWritten = b.createdAt.getTime() - a.createdAt.getTime();
	if (byWritten !== 0) return byWritten;
	if (a.id === b.id) return 0;
	return a.id < b.id ? 1 : -1;
}

/**
 * The group's OPEN Captures — the "Not recorded yet" tray (PLAN §7.7 "Recall").
 *
 * EVERY member sees EVERY member's open Captures (§7.7 "Group-visible") — there is
 * no author filter and there must not be one. The point is deduplication: seeing
 * "Sur — dinner, ~฿1,200, not recorded yet" is what stops the second person who
 * paid part of that dinner entering it twice.
 *
 * ONE ARM PER QUERY (issue #91), concatenated and ordered by {@link newestFirst}.
 * The arms are disjoint, so the concatenation is exactly the open set with nothing
 * counted twice; they are read separately because each has its own index and an
 * OR'd single query can use neither (see {@link reopenedArm}). The second arm is
 * the cheap one in the ordinary case: a group that has deleted no transaction has
 * nothing for it to find.
 */
export async function listOpenCaptures(userId: string, groupId: string): Promise<Capture[]> {
	await assertGroupAccess(userId, groupId);

	const inGroup = eq(captures.groupId, groupId);
	const [neverStamped, reopened] = await Promise.all([
		db.select().from(captures).where(and(inGroup, neverStampedArm())),
		db
			.select()
			.from(captures)
			.where(and(inGroup, reopenedArm(eq(transactions.groupId, groupId))))
	]);

	return [...neverStamped, ...reopened].sort(newestFirst);
}

/**
 * How many open Captures each of `groupIds` has — the persistent UNRECORDED COUNT
 * (PLAN §7.7 "Recall (no push)"), which sits on `/groups` (per group) and on the
 * group overview.
 *
 * BATCHED because `/groups` renders one card per group: a per-card count would be a
 * query per card. The group overview asks for a single id through the same function,
 * so the dashboard and the overview can never count differently.
 *
 * Counted in the DATABASE (`count()` + `group by`), not by reading the rows and
 * taking `.length`: this is recomputed on every page load, and the partial index
 * `captures_group_id_open_idx` exists precisely so it never scans a group's whole
 * history of already-recorded rows.
 *
 * ONE QUERY PER ARM (issue #91), summed here. Two round trips instead of one, and
 * the trade is deliberate: keeping both arms in a single OR'd query costs the
 * partial index — every page load would then read every note the group has ever
 * recorded — while each arm on its own is an index scan of something small (see
 * {@link reopenedArm}). Both arms are batched across ALL the caller's groups, so
 * this is two queries for a whole dashboard, not two per card. Summing is safe
 * because the arms are disjoint; a group with nothing open contributes no row to
 * either.
 *
 * AUTHORIZATION (§12) is the `members` + `groups` INNER JOIN in {@link countArm},
 * which is the batched form of `userHasGroupAccess` — an ACTIVE member link in a
 * group that is not soft-deleted. Both halves are there because that check has
 * both: a group the caller has no live member row in, and a soft-deleted group,
 * each contribute no row, so they are simply absent from the map rather than
 * reported as 0. Absent and zero are the same to a caller that reads `?? 0`, and
 * the distinction never leaks that a group exists.
 */
export async function countOpenCapturesByGroup({
	userId,
	groupIds
}: {
	userId: string;
	groupIds: readonly string[];
}): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	if (groupIds.length === 0) return counts;

	const ids = [...groupIds];
	const arms = await Promise.all([
		countArm(userId, ids, neverStampedArm()),
		countArm(userId, ids, reopenedArm(inArray(transactions.groupId, ids)))
	]);

	for (const row of arms.flat()) counts.set(row.groupId, (counts.get(row.groupId) ?? 0) + row.open);
	return counts;
}

/** One arm of the unrecorded count, access-gated and grouped. See above. */
function countArm(
	userId: string,
	groupIds: string[],
	arm: SQL | undefined
): Promise<{ groupId: string; open: number }[]> {
	return db
		.select({ groupId: captures.groupId, open: count() })
		.from(captures)
		.innerJoin(
			members,
			and(
				eq(members.groupId, captures.groupId),
				eq(members.userId, userId),
				isNull(members.deactivatedAt)
			)
		)
		.innerJoin(groups, and(eq(groups.id, captures.groupId), isNull(groups.deletedAt)))
		.where(and(inArray(captures.groupId, groupIds), arm))
		.groupBy(captures.groupId);
}

/**
 * Stamp a Capture as RECORDED, pointing at the transaction it became (§7.7
 * "Resolving").
 *
 * The row is never deleted — `resolved_transaction_id` + `resolved_at` are the
 * whole operation, which is what preserves the trail from remembering to
 * recording.
 *
 * `transactionId` is VERIFIED to name a live transaction IN THE SAME GROUP before
 * anything is stamped. Without that check the only link a Capture has into the
 * ledger could be pointed at another group's row by id, turning the trail into a
 * cross-group reference nobody can follow.
 *
 * The UPDATE carries {@link openCapturePredicate} itself (rather than trusting a
 * preceding read), so two members resolving the same Capture at the same moment
 * cannot both succeed: the loser affects zero rows and gets
 * {@link CaptureNotOpenError}.
 *
 * That predicate is also why a RE-OPENED note (issue #91 — recorded, then its
 * transaction soft-deleted) can be recorded again: it is open, so the tray's
 * "Record it" works on it like any other note, and the stamp moves to the
 * transaction that now holds the expense. The old link is not lost — the audit log
 * holds a `resolve` row for each recording, with its transaction id.
 */
export async function resolveCapture({
	userId,
	groupId,
	captureId,
	transactionId,
	via
}: {
	userId: string;
	groupId: string;
	captureId: string;
	transactionId: string;
	via?: AuditVia;
}): Promise<Capture> {
	return db.transaction(async (tx) => {
		await assertGroupAccess(userId, groupId, tx);
		return stampCaptureResolved(tx, { userId, groupId, captureId, transactionId, via });
	});
}

/**
 * The stamp itself, on an ALREADY-OPEN executor — the shared body of both resolve
 * paths (`resolveCapture` against a transaction that already exists, and
 * {@link recordCaptureAsTransaction} against one being written right now).
 *
 * Takes `tx` rather than reaching for `db`: the caller owns the transaction, and
 * that is the whole point (§12.1) — the stamp and the audit row commit with
 * whatever else that transaction is doing, or with none of it.
 *
 * Does NOT check group access. Both callers gate first (`resolveCapture` directly,
 * `recordCaptureAsTransaction` through `createTransaction`), and doing it here as
 * well would be a second membership round-trip inside every write.
 */
async function stampCaptureResolved(
	tx: DbExecutor,
	{
		userId,
		groupId,
		captureId,
		transactionId,
		via
	}: {
		userId: string;
		groupId: string;
		captureId: string;
		transactionId: string;
		via?: AuditVia;
	}
): Promise<Capture> {
	const [transaction] = await tx
		.select({ id: transactions.id })
		.from(transactions)
		.where(
			and(
				eq(transactions.id, transactionId),
				eq(transactions.groupId, groupId),
				isNull(transactions.deletedAt)
			)
		)
		.limit(1);
	if (!transaction) throw new TransactionNotFoundError();

	const [row] = await tx
		.update(captures)
		.set({ resolvedTransactionId: transactionId, resolvedAt: new Date() })
		.where(and(eq(captures.id, captureId), eq(captures.groupId, groupId), openCapturePredicate()))
		.returning();

	if (!row) throw await closedCaptureError(captureId, groupId, tx);

	await writeAuditLog(tx, {
		groupId,
		actorUserId: userId,
		action: 'resolve',
		entityType: 'capture',
		entityId: row.id,
		summary: `Recorded '${row.note}' from not recorded yet`,
		metadata: { note: row.note, transactionId },
		via
	});

	return row;
}

/**
 * ONE open Capture, for the prefill "Record it" opens (PLAN §7.7 "Resolving").
 *
 * Returns `null` — never throws — for a capture id that is missing, another
 * group's, or closed — recorded into a live transaction, or discarded (it carries
 * {@link openCapturePredicate}, so a note whose transaction was soft-deleted is
 * open and IS returned) — because the caller is a `load` seeding a
 * form from an UNTRUSTED query parameter: a stale link should land on the ordinary
 * blank add-transaction form, not on an error page. (The `?capture=` id is only a
 * pointer at a row; nothing about it is trusted, and the resolve itself re-checks
 * everything inside its own write.)
 *
 * Membership (§12) is still asserted, so a non-member cannot use this to learn
 * whether a capture id exists.
 */
export async function findOpenCapture({
	userId,
	groupId,
	captureId
}: {
	userId: string;
	groupId: string;
	captureId: string;
}): Promise<Capture | null> {
	await assertGroupAccess(userId, groupId);

	const [row] = await db
		.select()
		.from(captures)
		.where(and(eq(captures.id, captureId), eq(captures.groupId, groupId), openCapturePredicate()))
		.limit(1);

	return row ?? null;
}

/**
 * "Record it": create the real transaction a Capture became, and stamp the Capture
 * with it — IN ONE DB TRANSACTION (PLAN §7.7 "Resolving", §12.1).
 *
 * ── The prefill is a STARTING POINT, NOT A TRUSTED PAYLOAD ────────────────────
 * `input` goes through `createTransaction` unchanged, so every §7.4 rule runs in
 * full — payers summing to the total, the settlement side tying out, members
 * belonging to this group, the FX rate. A Capture carries no split information at
 * all (ADR-0012), so there is nothing here that could shortcut any of it: the
 * resulting row is an ORDINARY transaction and hits balances exactly as a
 * directly-entered one does.
 *
 * ── Why the stamp rides INSIDE the create ────────────────────────────────────
 * The two writes are one fact. Split across two transactions, a failure between
 * them leaves either a transaction whose Capture is still in everyone's tray
 * (§7.7's deduplication now actively causing the double entry it exists to
 * prevent) or a Capture pointing at a transaction that was rolled back. So the
 * stamp runs through `createTransaction`'s own `tx` (its `alsoWrite` hook), and a
 * Capture that someone else closed in the meantime throws
 * {@link CaptureNotOpenError} from INSIDE that transaction — taking the
 * half-written transaction with it. The double-submit's loser records nothing at
 * all, which is exactly what it should record.
 *
 * Returns the new transaction's id.
 */
export async function recordCaptureAsTransaction({
	userId,
	groupId,
	captureId,
	input,
	settlementCurrency,
	via
}: {
	userId: string;
	groupId: string;
	captureId: string;
	/** The RAW transaction input, exactly as `createTransaction` takes it. */
	input: unknown;
	settlementCurrency?: SeededCurrencyCode;
	via?: AuditVia;
}): Promise<string> {
	return createTransaction({
		userId,
		groupId,
		input,
		settlementCurrency,
		via,
		alsoWrite: async (tx, transactionId) => {
			await stampCaptureResolved(tx, { userId, groupId, captureId, transactionId, via });
		}
	});
}

/**
 * Give up on a Capture without recording it (PLAN §7.7 "Edge cases") — a SOFT
 * discard with an audit row.
 *
 * Soft because a Capture is never hard-deleted: "we decided this wasn't worth
 * recording" is itself part of the trail, and a group-visible row vanishing with
 * no explanation is exactly what the audit log exists to prevent.
 *
 * Same conditional UPDATE as {@link resolveCapture}, for the same race.
 */
export async function discardCapture({
	userId,
	groupId,
	captureId,
	via
}: {
	userId: string;
	groupId: string;
	captureId: string;
	via?: AuditVia;
}): Promise<Capture> {
	return db.transaction(async (tx) => {
		await assertGroupAccess(userId, groupId, tx);

		const [row] = await tx
			.update(captures)
			.set({ discardedAt: new Date() })
			.where(and(eq(captures.id, captureId), eq(captures.groupId, groupId), openCapturePredicate()))
			.returning();

		if (!row) throw await closedCaptureError(captureId, groupId, tx);

		await writeAuditLog(tx, {
			groupId,
			actorUserId: userId,
			action: 'discard',
			entityType: 'capture',
			entityId: row.id,
			summary: `Discarded '${row.note}' from not recorded yet`,
			metadata: { note: row.note },
			via
		});

		return row;
	});
}

/**
 * A conditional UPDATE affected no row: work out WHY and hand back the error to
 * throw (returned rather than thrown so the call site's `throw` narrows the row).
 *
 * The distinction is drawn only AFTER the group has been established, so it can't
 * leak anything: a missing id and another group's id are one `CaptureNotFoundError`
 * (404), while a Capture this member can genuinely see, already closed by someone
 * else, is a `CaptureNotOpenError` (409) that says which ending it got.
 *
 * `discarded_at` is tested FIRST, and the order is load-bearing (issue #91). The
 * two stamps used to be mutually exclusive — a discard required `resolved_at IS
 * NULL` — but a re-opened note can now be given up on, so
 * resolve → soft-delete → discard leaves a row carrying BOTH. `resolved_at` is
 * never cleared and `discarded_at` is never cleared either, so the discard is the
 * later and terminal fact: reading `resolved_at` first would tell whoever taps that
 * row next "someone already recorded this" and send them looking for a transaction
 * that represents nothing.
 */
async function closedCaptureError(
	captureId: string,
	groupId: string,
	executor: DbExecutor
): Promise<CaptureNotFoundError | CaptureNotOpenError> {
	const [existing] = await executor
		.select({ resolvedAt: captures.resolvedAt, discardedAt: captures.discardedAt })
		.from(captures)
		.where(and(eq(captures.id, captureId), eq(captures.groupId, groupId)))
		.limit(1);

	if (!existing) return new CaptureNotFoundError();
	return new CaptureNotOpenError(existing.discardedAt !== null ? 'discarded' : 'resolved');
}
