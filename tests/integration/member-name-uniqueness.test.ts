// Real-DB integration tests — ACTIVE-MEMBER DISPLAY-NAME UNIQUENESS
// (issues #75 + #76; PLAN §6.1–§6.3, §9; ADR-0015).
//
// Everything this suite covers is a DATABASE guarantee, so only a real Postgres can
// prove it. The unit specs cover the pieces separately — the folding rule
// (`src/lib/server/member-name.test.ts`), the declared index + hand-edited migration
// (`src/lib/server/db/groups-schema.test.ts`), and the error MAPPING against a stub
// (`src/lib/server/members.test.ts`) — but none of them can show that the running
// database actually REFUSES the second row, nor that the refusal really arrives as
// the SQLSTATE the mapping keys on. That is what this suite is for, and it drives
// the real service functions rather than raw inserts, so a call site that forgot to
// write the canonical key would fail here too.
//
// Issue #76 changed what a caller SEES: the three admin writes now translate the
// unique violation into a `DisplayNameTakenError` carrying an actionable message, so
// the assertions below are on that error — with one raw-insert test kept as proof
// that the DATABASE is still the guard and the service error only its wrapper.

import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createGroup } from '$lib/server/groups';
import {
	addMember,
	renameMember,
	removeMember,
	reactivateMember,
	DisplayNameTakenError,
	type Member
} from '$lib/server/members';
import { members } from '$lib/server/db/groups-schema';
import { isUniqueViolation } from '$lib/server/db/pg-errors';
import { displayNameValues, normalizeDisplayName } from '$lib/server/member-name';
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
	 * Run `fn` and return the `DisplayNameTakenError` it raised, failing the test if
	 * it succeeded or raised anything else. This is the whole #76 contract at the
	 * service boundary: a caller never sees a raw driver error.
	 */
	async function expectNameTaken(fn: () => Promise<unknown>): Promise<DisplayNameTakenError> {
		let thrown: unknown;
		try {
			await fn();
		} catch (e) {
			thrown = e;
		}
		expect(thrown, 'expected a name collision, but the write succeeded').toBeDefined();
		expect(
			thrown instanceof DisplayNameTakenError,
			`expected DisplayNameTakenError, got: ${String(thrown)}`
		).toBe(true);
		return thrown as DisplayNameTakenError;
	}

	/** Deactivate a member by forcing the soft branch (`hasActivity` → true). */
	function deactivate(memberId: string): Promise<{ action: string }> {
		return removeMember({ userId: owner.id, groupId, memberId }, async () => true);
	}

	// ── The constraint itself ──────────────────────────────────────────────────

	it('rejects a second ACTIVE member with the same display name', async () => {
		await add('Nan Suphaporn');
		const e = await expectNameTaken(() => add('Nan Suphaporn'));
		expect(e.groupId).toBe(groupId);
		expect(e.source).toBe('add');
		// Actionable, not a bare "constraint violated" (ADR-0009): it names the clash
		// and says what to do about it.
		expect(e.message).toContain('Nan Suphaporn');
		expect(e.message).toMatch(/different name/i);

		// And the failed write left nothing behind — the insert is the whole statement.
		const rows = await db.select().from(members).where(eq(members.groupId, groupId));
		expect(rows.filter((r) => r.displayName === 'Nan Suphaporn')).toHaveLength(1);
	});

	it('is the DATABASE refusing, not the service — a raw insert is rejected too', async () => {
		// The one test that keeps the guard honest. Everything else here goes through
		// `addMember`, which could in principle be passing on an app-level pre-check;
		// this bypasses the service entirely and still gets SQLSTATE 23505, proving the
		// partial index — not the mapping code — is what holds the invariant. The probe
		// is the PRODUCTION one, which walks the cause chain Drizzle wraps the driver
		// error in, exactly as the service does.
		await add('Nan');

		let thrown: unknown;
		try {
			await db.insert(members).values({ groupId, ...displayNameValues('  NAN  '), userId: null });
		} catch (err) {
			thrown = err;
		}
		expect(isUniqueViolation(thrown), `expected SQLSTATE 23505, got: ${String(thrown)}`).toBe(true);
	});

	it('catches a collision that only exists AFTER normalization', async () => {
		// The point of storing a folded key: none of these strings is byte-equal to the
		// first, so a naive unique index on `display_name` would accept every one.
		await add('Nan');
		for (const variant of ['nan', 'NAN', '  Nan', 'Nan  ', '\tnAn\n']) {
			await expectNameTaken(() => add(variant));
		}
	});

	it('catches a Unicode collision that only NFC composition reveals', async () => {
		// 'é' precomposed (U+00E9) vs 'e' + COMBINING ACUTE (U+0301): the same name to
		// a reader, different bytes to Postgres, equal only once NFC has run.
		await add('Ren\u00e9');
		await expectNameTaken(() => add('Rene\u0301'));
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
		await expectNameTaken(() => add('Nan'));

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

	// ── Collision handling in the three admin writes (issue #76) ───────────────

	it("rejects RENAMING onto an active member's name, and leaves the old name alone", async () => {
		const target = await add('Old Name');
		await add('Taken');

		const e = await expectNameTaken(() =>
			renameMember({ userId: owner.id, groupId, memberId: target.id, displayName: '  TAKEN  ' })
		);
		// The REQUESTED name (as typed), not the one the member still holds — that is
		// what the admin has to change.
		expect(e.displayName).toBe('  TAKEN  ');
		expect(e.source).toBe('rename');
		expect(e.message).toMatch(/different name/i);

		// The whole transaction rolled back: name AND canonical key untouched.
		const [row] = await db.select().from(members).where(eq(members.id, target.id));
		expect(row.displayName).toBe('Old Name');
		expect(row.normalizedDisplayName).toBe('old name');
	});

	it('lets the rename through once the colliding member is deactivated', async () => {
		const target = await add('Old Name');
		const blocker = await add('Taken');
		await expectNameTaken(() =>
			renameMember({ userId: owner.id, groupId, memberId: target.id, displayName: 'Taken' })
		);

		await deactivate(blocker.id);

		const renamed = await renameMember({
			userId: owner.id,
			groupId,
			memberId: target.id,
			displayName: 'Taken'
		});
		expect(renamed.displayName).toBe('Taken');
		expect(renamed.normalizedDisplayName).toBe('taken');
	});

	it('rejects REACTIVATING a member whose name an active member has taken', async () => {
		// The failure mode ADR-0015 hands to issue #76. The message must point at the
		// remedy the partial index leaves open (rename the inactive member first) —
		// "pick a different name" would be unactionable here, since the request carries
		// no name at all.
		const gone = await add('Nan');
		await deactivate(gone.id);
		await add('nan'); // same normalized key, different bytes

		const e = await expectNameTaken(() =>
			reactivateMember({ userId: owner.id, groupId, memberId: gone.id })
		);
		expect(e.source).toBe('reactivate');
		// The DEACTIVATED member's own name — the only one the admin can act on.
		expect(e.displayName).toBe('Nan');
		expect(e.message).toMatch(/rename the inactive member/i);

		const [row] = await db.select().from(members).where(eq(members.id, gone.id));
		expect(row.deactivatedAt, 'the failed reactivation must roll back').not.toBeNull();
	});

	it('lets the reactivation through once the blocker is RENAMED away', async () => {
		// The documented escape hatch, end to end: rename the inactive member, then
		// reactivate. (Renaming the ACTIVE holder works just as well; this is the path
		// the error text actually tells the admin to take.)
		const gone = await add('Nan');
		await deactivate(gone.id);
		await add('nan');
		await expectNameTaken(() => reactivateMember({ userId: owner.id, groupId, memberId: gone.id }));

		// Permitted precisely because the index does not cover inactive rows.
		await renameMember({ userId: owner.id, groupId, memberId: gone.id, displayName: 'Nan S.' });

		const back = await reactivateMember({ userId: owner.id, groupId, memberId: gone.id });
		expect(back.deactivatedAt).toBeNull();
		expect(back.displayName).toBe('Nan S.');
	});

	it('lets the reactivation through once the blocker is DEACTIVATED', async () => {
		const gone = await add('Nan');
		await deactivate(gone.id);
		const blocker = await add('NAN');
		await expectNameTaken(() => reactivateMember({ userId: owner.id, groupId, memberId: gone.id }));

		await deactivate(blocker.id);

		const back = await reactivateMember({ userId: owner.id, groupId, memberId: gone.id });
		expect(back.deactivatedAt).toBeNull();
		// Two rows now hold the same normalized key — legal, because only one is active.
		const rows = await db.select().from(members).where(eq(members.groupId, groupId));
		expect(rows.filter((r) => r.normalizedDisplayName === 'nan')).toHaveLength(2);
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
		await expectNameTaken(() => add('renamed here'));
	});

	it('writes the key for the creator member created with the group', async () => {
		const rows = await db.select().from(members).where(eq(members.groupId, groupId));
		const creator = rows.find((r) => r.userId === owner.id)!;
		expect(creator.normalizedDisplayName).toBe(normalizeDisplayName(creator.displayName));
	});
});
