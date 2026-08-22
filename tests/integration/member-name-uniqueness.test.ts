// Real-DB integration tests — ACTIVE-MEMBER DISPLAY-NAME UNIQUENESS
// (issue #75; PLAN §6.1–§6.3, §9; ADR-0015).
//
// Everything this task promises is a DATABASE guarantee, so only a real Postgres
// can prove it. The unit specs cover the two halves separately — the folding rule
// (`src/lib/server/member-name.test.ts`) and the declared index + hand-edited
// migration (`src/lib/server/db/groups-schema.test.ts`) — but neither can show that
// the running database actually REFUSES the second row. That is what this suite is
// for, and it drives the real service functions rather than raw inserts, so a call
// site that forgot to write the canonical key would fail here too.
//
// A note on what a failing insert looks like today: this task deliberately ships the
// CONSTRAINT ONLY. Turning the raw SQLSTATE 23505 into an actionable, self-correcting
// error is issue #76 (`addMember` / `renameMember` / `reactivateMember`) and #79
// (invite-accept's auto-suffix). So the assertions below are on the Postgres error,
// which is exactly the surface those tasks will wrap.

import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createGroup } from '$lib/server/groups';
import {
	addMember,
	renameMember,
	removeMember,
	reactivateMember,
	type Member
} from '$lib/server/members';
import { members } from '$lib/server/db/groups-schema';
import { isUniqueViolation } from '$lib/server/db/pg-errors';
import { normalizeDisplayName } from '$lib/server/member-name';
import { createTestUser, cleanupSuiteRows, db, describeIntegration } from './helpers';

describeIntegration('integration: active-member name uniqueness (ADR-0015)', () => {
	let owner: { id: string; name: string };
	let groupId: string;
	/** A second group, to prove the constraint is scoped PER GROUP. */
	let otherGroupId: string;

	beforeEach(async () => {
		owner = await createTestUser('owner');
		const group = await createGroup({
			userId: owner.id,
			userName: owner.name,
			name: 'Names',
			settlementCurrency: 'USD'
		});
		groupId = group.id;
		const other = await createGroup({
			userId: owner.id,
			userName: owner.name,
			name: 'Other names',
			settlementCurrency: 'USD'
		});
		otherGroupId = other.id;
	});

	afterEach(async () => {
		await cleanupSuiteRows();
	});

	/** Add a member to the suite's main group. */
	function add(displayName: string, group = groupId): Promise<Member> {
		return addMember({ userId: owner.id, groupId: group, displayName });
	}

	/**
	 * Run `fn` and return the unique-violation it raised, failing the test if it
	 * succeeded or raised anything else. Uses the PRODUCTION probe
	 * (`isUniqueViolation`), which walks the cause chain Drizzle wraps the driver
	 * error in — the same probe issue #76 will branch on.
	 */
	async function expectUniqueViolation(fn: () => Promise<unknown>): Promise<void> {
		let thrown: unknown;
		try {
			await fn();
		} catch (e) {
			thrown = e;
		}
		expect(thrown, 'expected a unique violation, but the write succeeded').toBeDefined();
		expect(isUniqueViolation(thrown), `expected SQLSTATE 23505, got: ${String(thrown)}`).toBe(true);
	}

	/** Deactivate a member by forcing the soft branch (`hasActivity` → true). */
	function deactivate(memberId: string): Promise<{ action: string }> {
		return removeMember({ userId: owner.id, groupId, memberId }, async () => true);
	}

	// ── The constraint itself ──────────────────────────────────────────────────

	it('rejects a second ACTIVE member with the same display name', async () => {
		await add('Nan Suphaporn');
		await expectUniqueViolation(() => add('Nan Suphaporn'));

		// And the failed write left nothing behind — the insert is the whole statement.
		const rows = await db.select().from(members).where(eq(members.groupId, groupId));
		expect(rows.filter((r) => r.displayName === 'Nan Suphaporn')).toHaveLength(1);
	});

	it('catches a collision that only exists AFTER normalization', async () => {
		// The point of storing a folded key: none of these strings is byte-equal to the
		// first, so a naive unique index on `display_name` would accept every one.
		await add('Nan');
		for (const variant of ['nan', 'NAN', '  Nan', 'Nan  ', '\tnAn\n']) {
			await expectUniqueViolation(() => add(variant));
		}
	});

	it('catches a Unicode collision that only NFC composition reveals', async () => {
		// 'é' precomposed (U+00E9) vs 'e' + COMBINING ACUTE (U+0301): the same name to
		// a reader, different bytes to Postgres, equal only once NFC has run.
		await add('Ren\u00e9');
		await expectUniqueViolation(() => add('Rene\u0301'));
	});

	it('allows names that merely LOOK similar — it is an equality test, not a hint', async () => {
		// ADR-0015 "What this does not fix": `similar-names.ts` relates these two; the
		// constraint must not, or a real second person could not be added at all.
		await add('Nan Suphaporn');
		await add('Nanthawat P.');
		await add('Nan');
		// Inner whitespace is significant — no squeezing (see `normalizeDisplayName`).
		await add('Nan  Suphaporn');

		const rows = await db.select().from(members).where(eq(members.groupId, groupId));
		// The four above plus the group creator's own member row.
		expect(rows).toHaveLength(5);
	});

	it('is scoped PER GROUP — the same name is free in another group', async () => {
		await add('Nan');
		await expect(add('Nan', otherGroupId)).resolves.toMatchObject({ displayName: 'Nan' });
	});

	// ── The deactivated-member exemption (§6.3) ────────────────────────────────

	it('frees the name once its holder is deactivated', async () => {
		const first = await add('Nan');
		await expectUniqueViolation(() => add('Nan'));

		await deactivate(first.id);

		// Now the name is reusable — the index only constrains `deactivated_at IS NULL`.
		const second = await add('Nan');
		expect(second.id).not.toBe(first.id);

		// BOTH rows still exist, both still named 'Nan': the ledger is never rewritten.
		const rows = await db.select().from(members).where(eq(members.groupId, groupId));
		expect(rows.filter((r) => r.displayName === 'Nan')).toHaveLength(2);
	});

	it('lets a DEACTIVATED member be renamed onto an active name', async () => {
		// The escape hatch ADR-0015 depends on: an admin facing a blocked reactivation
		// renames the deactivated member first, which the partial index must permit
		// even when the target name is taken by an active member.
		const gone = await add('Old Name');
		await deactivate(gone.id);
		await add('Taken');

		const renamed = await renameMember({
			userId: owner.id,
			groupId,
			memberId: gone.id,
			displayName: 'Taken'
		});
		expect(renamed.displayName).toBe('Taken');
		expect(renamed.deactivatedAt).not.toBeNull();
	});

	it('rejects REACTIVATING a member whose name an active member has taken', async () => {
		// The new failure mode ADR-0015 hands to issue #76: today it surfaces as the raw
		// unique violation, which is what that task will translate into a "rename the
		// deactivated member first" error. The row must stay deactivated meanwhile.
		const gone = await add('Nan');
		await deactivate(gone.id);
		await add('nan'); // same normalized key, different bytes

		await expectUniqueViolation(() =>
			reactivateMember({ userId: owner.id, groupId, memberId: gone.id })
		);

		const [row] = await db.select().from(members).where(eq(members.id, gone.id));
		expect(row.deactivatedAt, 'the failed reactivation must roll back').not.toBeNull();
	});

	// ── The stored key stays in step with the name ─────────────────────────────

	it('stores the canonical key on add, and MOVES it on rename', async () => {
		const m = await add('  Mixed CASE Name  ');
		let [row] = await db.select().from(members).where(eq(members.id, m.id));
		// The display form is stored verbatim; only the key is folded.
		expect(row.normalizedDisplayName).toBe(normalizeDisplayName(row.displayName));
		expect(row.normalizedDisplayName).toBe('mixed case name');

		await renameMember({ userId: owner.id, groupId, memberId: m.id, displayName: 'Renamed HERE' });
		[row] = await db.select().from(members).where(eq(members.id, m.id));
		expect(row.normalizedDisplayName).toBe('renamed here');

		// The proof the rename really moved the key: the OLD name is free again and the
		// NEW one is not.
		await add('Mixed CASE Name');
		await expectUniqueViolation(() => add('renamed here'));
	});

	it('writes the key for the creator member created with the group', async () => {
		const rows = await db.select().from(members).where(eq(members.groupId, groupId));
		const creator = rows.find((r) => r.userId === owner.id)!;
		expect(creator.normalizedDisplayName).toBe(normalizeDisplayName(creator.displayName));
	});
});
