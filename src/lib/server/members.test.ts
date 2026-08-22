import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for the member service (PLAN §6.1, §6.2, §6.3, §12).
//
// STRATEGY (mirrors `groups.test.ts`): there is NO real DB here — real CRUD
// round-trips are deferred to the task 3.9 integration tests. We mock
// `$lib/server/db` with a small fluent query-builder stub so we can assert the
// *meaningful* service guarantees:
//   - the PURE `decideMemberRemoval` branch rule, both ways, directly.
//   - `addMember` inserts a NEW UNLINKED member (`user_id = null`) under access.
//   - access-denied throws `GroupAccessError` for list/add/rename/remove/reactivate.
//   - a member not in the group → `MemberNotFoundError` (cross-group guard).
//   - `removeMember` soft-deactivates vs hard-deletes per the activity branch —
//     driven through the injectable `hasActivity` seam and asserted via the
//     recorded update/delete calls + the result.
//
// The stub lets each test PROGRAM what the SELECTs resolve to (access check,
// then member-in-group lookup) in order, and records insert/update/delete calls.

// --- Fluent DB mock -------------------------------------------------------
const { selectQueue, insertCalls, updateCalls, deleteCalls, failNext, makeDb } = vi.hoisted(() => {
	// A queue of row-sets the SELECT chains resolve to, in call order. The first
	// SELECT in a mutation is the access check; the second is the member lookup.
	const selectQueue: unknown[][] = [];
	const insertCalls: { table: unknown; values: unknown }[] = [];
	const updateCalls: { set: unknown }[] = [];
	const deleteCalls: { where: boolean }[] = [];

	function nextSelectRows(): unknown[] {
		return selectQueue.length > 0 ? (selectQueue.shift() as unknown[]) : [];
	}

	// A programmed failure for the NEXT write that calls `.returning()` — the seam
	// that exercises the unique-violation MAPPING (23505 → `DisplayNameTakenError`)
	// without a database. Deliberately only the mapping: whether a real Postgres
	// failure actually carries 23505 down Drizzle's cause chain is a claim only the
	// integration suite can make (see `db/pg-errors.ts`), and this stub throws
	// whatever it is told to.
	const failNext: { error?: unknown } = {};
	function takeFailure(): unknown | undefined {
		const e = failNext.error;
		failNext.error = undefined;
		return e;
	}

	// A thenable chain: builder methods return the same object; awaiting it (or a
	// terminal) yields the next programmed row-set.
	function selectChain() {
		const rows = nextSelectRows();
		const chain: Record<string, unknown> = {};
		// `for` backs `.for('update')` — `removeMember` locks the member row before it
		// probes for ledger activity, so the stub has to be able to model that call.
		const methods = ['from', 'innerJoin', 'where', 'limit', 'orderBy', 'for'];
		for (const m of methods) chain[m] = () => chain;
		chain.then = (resolve: (v: unknown) => unknown) => resolve(rows);
		return chain;
	}

	function insertChain(table: unknown) {
		return {
			values(values: unknown) {
				insertCalls.push({ table, values });
				return {
					returning: () => {
						const failure = takeFailure();
						return failure
							? Promise.reject(failure)
							: Promise.resolve([{ id: 'member-1', ...(values as object) }]);
					},
					then: (resolve: (v: unknown) => unknown) => resolve(undefined)
				};
			}
		};
	}

	function updateChain() {
		const chain: Record<string, unknown> = {};
		chain.set = (v: unknown) => {
			updateCalls.push({ set: v });
			return chain;
		};
		chain.where = () => chain;
		chain.returning = () => {
			const failure = takeFailure();
			return failure
				? Promise.reject(failure)
				: Promise.resolve([{ id: 'member-1', displayName: 'Updated Name' }]);
		};
		chain.then = (resolve: (v: unknown) => unknown) => resolve(undefined);
		return chain;
	}

	function deleteChain() {
		return {
			where() {
				deleteCalls.push({ where: true });
				return Promise.resolve(undefined);
			}
		};
	}

	const executor = {
		select: () => selectChain(),
		insert: (table: unknown) => insertChain(table),
		update: () => updateChain(),
		delete: () => deleteChain()
	};

	const db = {
		...executor,
		transaction: (cb: (tx: typeof executor) => Promise<unknown>) => cb(executor)
	};

	return { selectQueue, insertCalls, updateCalls, deleteCalls, failNext, makeDb: () => db };
});

vi.mock('$lib/server/db', () => ({ db: makeDb() }));

import {
	listMembers,
	addMember,
	renameMember,
	removeMember,
	reactivateMember,
	decideMemberRemoval,
	DisplayNameTakenError,
	MemberNotFoundError
} from './members';
import { GroupAccessError } from './groups';
import { auditLog } from './db/audit-schema';

/** Queue the row-sets each successive SELECT chain resolves to. */
function queueSelects(...rowSets: unknown[][]) {
	selectQueue.length = 0;
	selectQueue.push(...rowSets);
}

/** The recorded `insert(table).values(v)` calls that targeted the audit_log table. */
function auditInserts() {
	return insertCalls.filter((c) => c.table === auditLog);
}

/** An access-granting member row (the access SELECT finds one). */
const ACCESS_OK = [{ id: 'access-member' }];
/** A target member row in the group (the lookup SELECT finds it). */
const TARGET_MEMBER = [{ id: 'm1', groupId: 'g1', displayName: 'Alex', userId: null }];

beforeEach(() => {
	insertCalls.length = 0;
	updateCalls.length = 0;
	deleteCalls.length = 0;
	selectQueue.length = 0;
	failNext.error = undefined;
});

/**
 * A stand-in for what Drizzle throws on a constraint trip: the driver error nested
 * in `cause`, exactly as `isUniqueViolation` expects to find it. `code` defaults to
 * the unique-violation SQLSTATE.
 */
function pgError(code = '23505'): Error {
	return new Error('drizzle query error', { cause: Object.assign(new Error('pg'), { code }) });
}

describe('decideMemberRemoval (pure removal-branch rule — PLAN §6.3)', () => {
	it("returns 'hard_delete' for a member with zero activity", () => {
		expect(decideMemberRemoval(false)).toBe('hard_delete');
	});

	it("returns 'soft_deactivate' for a member with any activity", () => {
		expect(decideMemberRemoval(true)).toBe('soft_deactivate');
	});
});

describe('listMembers (PLAN §6.3 — includes deactivated, marked inactive)', () => {
	it('throws GroupAccessError when the user has no access', async () => {
		queueSelects([]); // access check finds nothing
		await expect(listMembers({ userId: 'u1', groupId: 'g1' })).rejects.toBeInstanceOf(
			GroupAccessError
		);
	});

	it('returns all members (active first), each shaped with isLinked + deactivatedAt', async () => {
		const deactivatedAt = new Date('2026-02-01T00:00:00.000Z');
		queueSelects(ACCESS_OK, [
			// Intentionally out of order to prove the sort: inactive linked first.
			{ id: 'm2', groupId: 'g1', displayName: 'Zed', userId: 'user-9', deactivatedAt },
			{ id: 'm1', groupId: 'g1', displayName: 'Alex', userId: null, deactivatedAt: null }
		]);

		const result = await listMembers({ userId: 'u1', groupId: 'g1' });

		// Active member sorts before the inactive one.
		expect(result.map((m) => m.id)).toEqual(['m1', 'm2']);
		expect(result[0]).toEqual({
			id: 'm1',
			displayName: 'Alex',
			userId: null,
			deactivatedAt: null,
			isLinked: false
		});
		expect(result[1]).toEqual({
			id: 'm2',
			displayName: 'Zed',
			userId: 'user-9',
			deactivatedAt: deactivatedAt.toISOString(),
			isLinked: true
		});
	});
});

describe('addMember (PLAN §6.1 — inserts a NEW UNLINKED slot)', () => {
	it('inserts a member with user_id = null under access', async () => {
		queueSelects(ACCESS_OK); // access check passes
		const member = await addMember({ userId: 'u1', groupId: 'g1', displayName: 'Alex' });

		// The member insert + the audit insert (both on the same tx).
		const memberInserts = insertCalls.filter((c) => c.table !== auditLog);
		expect(memberInserts).toHaveLength(1);
		const values = memberInserts[0].values as Record<string, unknown>;
		expect(values).toMatchObject({ groupId: 'g1', displayName: 'Alex' });
		// The defining property: a participant slot, NOT a user link.
		expect(values.userId).toBeNull();
		expect(member.id).toBe('member-1');
	});

	it('writes the canonical name key alongside the name (ADR-0015)', async () => {
		// The uniqueness index compares STORED keys, so an insert that omitted this
		// column (or wrote an unfolded value) would leave the constraint unable to see
		// a case/whitespace-only duplicate. Padded + mixed case on purpose.
		queueSelects(ACCESS_OK);
		await addMember({ userId: 'u1', groupId: 'g1', displayName: '  ALEX  ' });

		const values = insertCalls.filter((c) => c.table !== auditLog)[0].values as Record<
			string,
			unknown
		>;
		expect(values.displayName).toBe('  ALEX  ');
		expect(values.normalizedDisplayName).toBe('alex');
	});

	it('writes exactly ONE add/member audit row in the same transaction', async () => {
		queueSelects(ACCESS_OK);
		await addMember({ userId: 'u1', groupId: 'g1', displayName: 'Alex' });

		const audits = auditInserts();
		expect(audits).toHaveLength(1);
		const v = audits[0].values as Record<string, unknown>;
		expect(v).toMatchObject({
			groupId: 'g1',
			actorUserId: 'u1',
			action: 'add',
			entityType: 'member',
			entityId: 'member-1'
		});
		expect(v.summary).toBe("Added member 'Alex'");
	});

	it('writes NO audit row when access is denied', async () => {
		queueSelects([]);
		await expect(
			addMember({ userId: 'u1', groupId: 'g1', displayName: 'Alex' })
		).rejects.toBeInstanceOf(GroupAccessError);
		expect(auditInserts()).toHaveLength(0);
	});

	it('throws GroupAccessError and inserts nothing when access is denied', async () => {
		queueSelects([]); // access check finds nothing
		await expect(
			addMember({ userId: 'u1', groupId: 'g1', displayName: 'Alex' })
		).rejects.toBeInstanceOf(GroupAccessError);
		expect(insertCalls).toHaveLength(0);
	});
});

describe('renameMember (PLAN §6.2 — display name editable)', () => {
	it('throws GroupAccessError when access is denied', async () => {
		queueSelects([]); // access check fails
		await expect(
			renameMember({ userId: 'u1', groupId: 'g1', memberId: 'm1', displayName: 'New' })
		).rejects.toBeInstanceOf(GroupAccessError);
		expect(updateCalls).toHaveLength(0);
	});

	it('throws MemberNotFoundError when the member is not in the group', async () => {
		queueSelects(ACCESS_OK, []); // access ok, but member lookup finds nothing
		await expect(
			renameMember({ userId: 'u1', groupId: 'g1', memberId: 'nope', displayName: 'New' })
		).rejects.toBeInstanceOf(MemberNotFoundError);
		expect(updateCalls).toHaveLength(0);
	});

	it('updates the display name when access + membership check pass', async () => {
		queueSelects(ACCESS_OK, TARGET_MEMBER);
		const updated = await renameMember({
			userId: 'u1',
			groupId: 'g1',
			memberId: 'm1',
			displayName: 'New'
		});
		expect(updateCalls).toHaveLength(1);
		expect((updateCalls[0].set as Record<string, unknown>).displayName).toBe('New');
		expect(updated.id).toBe('member-1');
	});

	it('moves the canonical name key WITH the name (ADR-0015)', async () => {
		// A rename that left the old key behind would silently disable the uniqueness
		// index for that row: it would keep matching its former name and stop matching
		// its current one.
		queueSelects(ACCESS_OK, TARGET_MEMBER);
		await renameMember({ userId: 'u1', groupId: 'g1', memberId: 'm1', displayName: 'NEW Name' });

		const set = updateCalls[0].set as Record<string, unknown>;
		expect(set.displayName).toBe('NEW Name');
		expect(set.normalizedDisplayName).toBe('new name');
	});
});

describe('removeMember (PLAN §6.3 — soft-deactivate vs hard-delete)', () => {
	it('throws GroupAccessError when access is denied', async () => {
		queueSelects([]);
		await expect(
			removeMember({ userId: 'u1', groupId: 'g1', memberId: 'm1' })
		).rejects.toBeInstanceOf(GroupAccessError);
		expect(updateCalls).toHaveLength(0);
		expect(deleteCalls).toHaveLength(0);
	});

	it('throws MemberNotFoundError when the member is not in the group', async () => {
		queueSelects(ACCESS_OK, []);
		await expect(
			removeMember({ userId: 'u1', groupId: 'g1', memberId: 'nope' })
		).rejects.toBeInstanceOf(MemberNotFoundError);
	});

	it('HARD-DELETES a member with zero activity (no activity → hard delete)', async () => {
		// Pass the activity predicate explicitly (false) for clarity; the same
		// outcome holds via the real default until task 4.2 wires activity.
		queueSelects(ACCESS_OK, TARGET_MEMBER);
		const result = await removeMember(
			{ userId: 'u1', groupId: 'g1', memberId: 'm1' },
			async () => false
		);

		expect(result.action).toBe('hard_delete');
		expect(deleteCalls).toHaveLength(1);
		// No soft-deactivate update on the hard-delete path.
		expect(updateCalls).toHaveLength(0);
	});

	it('SOFT-DEACTIVATES a member with activity (real service branch via the seam)', async () => {
		// Drive the REAL `removeMember` down the soft path by injecting an activity
		// predicate that returns true (the production default `memberHasActivity` is
		// deferred to task 4.2). Same access-OK + target-member SELECTs as hard-delete.
		queueSelects(ACCESS_OK, TARGET_MEMBER);
		const result = await removeMember(
			{ userId: 'u1', groupId: 'g1', memberId: 'm1' },
			async () => true
		);

		expect(result.action).toBe('soft_deactivate');
		// Exactly one soft-deactivate update stamping `deactivated_at`; no delete.
		expect(updateCalls).toHaveLength(1);
		expect((updateCalls[0].set as Record<string, unknown>).deactivatedAt).toBeInstanceOf(Date);
		expect(deleteCalls).toHaveLength(0);
	});

	it('soft-deactivates when the DEFAULT predicate finds a payer row', async () => {
		// No second argument: drives the REAL `memberHasActivity`, not the seam.
		// SELECT order: access check, member lookup, transaction_payers probe.
		queueSelects(ACCESS_OK, TARGET_MEMBER, [{ memberId: 'm1' }]);
		const result = await removeMember({ userId: 'u1', groupId: 'g1', memberId: 'm1' });

		expect(result.action).toBe('soft_deactivate');
		expect(updateCalls).toHaveLength(1);
		expect(deleteCalls).toHaveLength(0);
	});

	it('hard-deletes when the DEFAULT predicate finds no payer and no share row', async () => {
		// SELECT order: access check, member lookup, empty payers probe, empty
		// shares probe.
		queueSelects(ACCESS_OK, TARGET_MEMBER, [], []);
		const result = await removeMember({ userId: 'u1', groupId: 'g1', memberId: 'm1' });

		expect(result.action).toBe('hard_delete');
		expect(deleteCalls).toHaveLength(1);
		expect(updateCalls).toHaveLength(0);
	});

	it('soft-deactivates when the DEFAULT predicate finds only a share row', async () => {
		// Payer probe empty, share probe finds a row.
		queueSelects(ACCESS_OK, TARGET_MEMBER, [], [{ memberId: 'm1' }]);
		const result = await removeMember({ userId: 'u1', groupId: 'g1', memberId: 'm1' });

		expect(result.action).toBe('soft_deactivate');
		expect(updateCalls).toHaveLength(1);
		expect(deleteCalls).toHaveLength(0);
	});
});

describe('reactivateMember (PLAN §6.3 — flag flip)', () => {
	it('throws GroupAccessError when access is denied', async () => {
		queueSelects([]);
		await expect(
			reactivateMember({ userId: 'u1', groupId: 'g1', memberId: 'm1' })
		).rejects.toBeInstanceOf(GroupAccessError);
		expect(updateCalls).toHaveLength(0);
	});

	it('throws MemberNotFoundError when the member is not in the group', async () => {
		queueSelects(ACCESS_OK, []);
		await expect(
			reactivateMember({ userId: 'u1', groupId: 'g1', memberId: 'nope' })
		).rejects.toBeInstanceOf(MemberNotFoundError);
	});

	it('clears deactivated_at when access + membership pass', async () => {
		queueSelects(ACCESS_OK, TARGET_MEMBER);
		const updated = await reactivateMember({ userId: 'u1', groupId: 'g1', memberId: 'm1' });
		expect(updateCalls).toHaveLength(1);
		expect((updateCalls[0].set as Record<string, unknown>).deactivatedAt).toBeNull();
		expect(updated.id).toBe('member-1');
	});
});

describe('active-name collisions (issue #76; ADR-0015)', () => {
	// What is asserted here is the TRANSLATION — a unique violation coming back from
	// the write becomes a `DisplayNameTakenError` carrying an actionable message,
	// and anything else propagates untouched. That the database really raises 23505
	// for a normalized duplicate is the integration suite's claim
	// (`tests/integration/member-name-uniqueness.test.ts`), not this stub's.

	it('addMember maps a unique violation to DisplayNameTakenError', async () => {
		queueSelects(ACCESS_OK);
		failNext.error = pgError();

		const thrown = await addMember({
			userId: 'u1',
			groupId: 'g1',
			displayName: 'Alex'
		}).catch((e: unknown) => e);

		expect(thrown).toBeInstanceOf(DisplayNameTakenError);
		const taken = thrown as DisplayNameTakenError;
		expect(taken.code).toBe('display_name_taken');
		expect(taken.groupId).toBe('g1');
		// The name AS SUBMITTED, not the folded key — the admin has to recognize it.
		expect(taken.displayName).toBe('Alex');
		expect(taken.source).toBe('add');
		expect(taken.message).toContain('Alex');
		expect(taken.message).toContain('different name');
	});

	it('addMember RETHROWS a non-unique database failure unchanged', async () => {
		// The mapping must not swallow unrelated failures into a user-facing
		// "pick another name" (23503 = foreign-key violation).
		queueSelects(ACCESS_OK);
		const original = pgError('23503');
		failNext.error = original;

		await expect(addMember({ userId: 'u1', groupId: 'g1', displayName: 'Alex' })).rejects.toBe(
			original
		);
	});

	it('addMember writes NO audit row when the insert collided', async () => {
		// The audit write comes after the insert, so a rejected insert must not leave
		// an "Added member" line behind (PLAN §12.1 — audit joins the same tx).
		queueSelects(ACCESS_OK);
		failNext.error = pgError();

		await expect(addMember({ userId: 'u1', groupId: 'g1', displayName: 'Alex' })).rejects.toThrow();
		expect(auditInserts()).toHaveLength(0);
	});

	it('renameMember maps a unique violation to DisplayNameTakenError', async () => {
		queueSelects(ACCESS_OK, TARGET_MEMBER);
		failNext.error = pgError();

		const thrown = await renameMember({
			userId: 'u1',
			groupId: 'g1',
			memberId: 'm1',
			displayName: 'Taken'
		}).catch((e: unknown) => e);

		expect(thrown).toBeInstanceOf(DisplayNameTakenError);
		// The REQUESTED name, not the one the member currently holds.
		expect((thrown as DisplayNameTakenError).displayName).toBe('Taken');
		expect((thrown as DisplayNameTakenError).source).toBe('rename');
		expect(auditInserts()).toHaveLength(0);
	});

	it('renameMember RETHROWS a non-unique database failure unchanged', async () => {
		queueSelects(ACCESS_OK, TARGET_MEMBER);
		const original = pgError('40001');
		failNext.error = original;

		await expect(
			renameMember({ userId: 'u1', groupId: 'g1', memberId: 'm1', displayName: 'Taken' })
		).rejects.toBe(original);
	});

	it("reactivateMember reports the DEACTIVATED member's own name and the remedy", async () => {
		// Reactivate submits an id only, so the message can only name the clash by
		// reading the target row first — and the remedy has to be the one the partial
		// index leaves open (rename the inactive member, then reactivate).
		queueSelects(ACCESS_OK, TARGET_MEMBER); // TARGET_MEMBER is named 'Alex'
		failNext.error = pgError();

		const thrown = await reactivateMember({
			userId: 'u1',
			groupId: 'g1',
			memberId: 'm1'
		}).catch((e: unknown) => e);

		expect(thrown).toBeInstanceOf(DisplayNameTakenError);
		const taken = thrown as DisplayNameTakenError;
		expect(taken.displayName).toBe('Alex');
		expect(taken.source).toBe('reactivate');
		expect(taken.message).toContain('Alex');
		expect(taken.message).toMatch(/rename the inactive member/i);
		expect(auditInserts()).toHaveLength(0);
	});

	it('reactivateMember RETHROWS a non-unique database failure unchanged', async () => {
		queueSelects(ACCESS_OK, TARGET_MEMBER);
		const original = pgError('23514');
		failNext.error = original;

		await expect(reactivateMember({ userId: 'u1', groupId: 'g1', memberId: 'm1' })).rejects.toBe(
			original
		);
	});
});

describe('audit writes (task 6.1, PLAN §12.1 — same transaction)', () => {
	it('renameMember writes one rename/member audit row with from/to metadata', async () => {
		queueSelects(ACCESS_OK, TARGET_MEMBER);
		await renameMember({ userId: 'u1', groupId: 'g1', memberId: 'm1', displayName: 'New' });

		const audits = auditInserts();
		expect(audits).toHaveLength(1);
		const v = audits[0].values as Record<string, unknown>;
		expect(v).toMatchObject({
			groupId: 'g1',
			actorUserId: 'u1',
			action: 'rename',
			entityType: 'member',
			entityId: 'm1'
		});
		// before = the loaded target's name ('Alex'); after = the update's returning.
		expect(v.metadata).toEqual({ from: 'Alex', to: 'Updated Name' });
	});

	it('removeMember soft-deactivate writes one deactivate/member audit row', async () => {
		queueSelects(ACCESS_OK, TARGET_MEMBER);
		await removeMember({ userId: 'u1', groupId: 'g1', memberId: 'm1' }, async () => true);

		const audits = auditInserts();
		expect(audits).toHaveLength(1);
		const v = audits[0].values as Record<string, unknown>;
		expect(v).toMatchObject({
			action: 'deactivate',
			entityType: 'member',
			entityId: 'm1'
		});
		expect(v.summary).toBe("Deactivated member 'Alex'");
	});

	it('removeMember HARD-DELETE writes NO audit row (zero-activity cleanup)', async () => {
		queueSelects(ACCESS_OK, TARGET_MEMBER);
		const result = await removeMember(
			{ userId: 'u1', groupId: 'g1', memberId: 'm1' },
			async () => false
		);

		expect(result.action).toBe('hard_delete');
		// The decision: no `delete`/`member` row referencing a row that no longer exists.
		expect(auditInserts()).toHaveLength(0);
	});

	it('reactivateMember writes one reactivate/member audit row', async () => {
		queueSelects(ACCESS_OK, TARGET_MEMBER);
		await reactivateMember({ userId: 'u1', groupId: 'g1', memberId: 'm1' });

		const audits = auditInserts();
		expect(audits).toHaveLength(1);
		const v = audits[0].values as Record<string, unknown>;
		expect(v).toMatchObject({
			action: 'reactivate',
			entityType: 'member',
			entityId: 'm1'
		});
	});

	it('writes NO audit row when access is denied (rename rolls back)', async () => {
		queueSelects([]); // access denied
		await expect(
			renameMember({ userId: 'u1', groupId: 'g1', memberId: 'm1', displayName: 'New' })
		).rejects.toBeInstanceOf(GroupAccessError);
		expect(auditInserts()).toHaveLength(0);
	});

	it('writes NO audit row when the member is not in the group', async () => {
		queueSelects(ACCESS_OK, []); // access ok, member lookup empty
		await expect(
			reactivateMember({ userId: 'u1', groupId: 'g1', memberId: 'nope' })
		).rejects.toBeInstanceOf(MemberNotFoundError);
		expect(auditInserts()).toHaveLength(0);
	});
});
