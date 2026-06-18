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
const { selectQueue, insertCalls, updateCalls, deleteCalls, makeDb } = vi.hoisted(() => {
	// A queue of row-sets the SELECT chains resolve to, in call order. The first
	// SELECT in a mutation is the access check; the second is the member lookup.
	const selectQueue: unknown[][] = [];
	const insertCalls: { table: unknown; values: unknown }[] = [];
	const updateCalls: { set: unknown }[] = [];
	const deleteCalls: { where: boolean }[] = [];

	function nextSelectRows(): unknown[] {
		return selectQueue.length > 0 ? (selectQueue.shift() as unknown[]) : [];
	}

	// A thenable chain: builder methods return the same object; awaiting it (or a
	// terminal) yields the next programmed row-set.
	function selectChain() {
		const rows = nextSelectRows();
		const chain: Record<string, unknown> = {};
		const methods = ['from', 'innerJoin', 'where', 'limit', 'orderBy'];
		for (const m of methods) chain[m] = () => chain;
		chain.then = (resolve: (v: unknown) => unknown) => resolve(rows);
		return chain;
	}

	function insertChain(table: unknown) {
		return {
			values(values: unknown) {
				insertCalls.push({ table, values });
				return {
					returning: () => Promise.resolve([{ id: 'member-1', ...(values as object) }]),
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
		chain.returning = () => Promise.resolve([{ id: 'member-1', displayName: 'Updated Name' }]);
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

	return { selectQueue, insertCalls, updateCalls, deleteCalls, makeDb: () => db };
});

vi.mock('$lib/server/db', () => ({ db: makeDb() }));

import {
	listMembers,
	addMember,
	renameMember,
	removeMember,
	reactivateMember,
	decideMemberRemoval,
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
});

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
