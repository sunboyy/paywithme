// Shared helpers for the real-DB integration suite (task 3.9).
//
// Responsibilities:
//   1. CONNECTIVITY GUARD — probe the local Postgres once (a `SELECT 1` plus a
//      check that the Phase-3 tables exist). If it's unreachable, expose a
//      `describeIntegration` that downgrades to `describe.skip` with a clear
//      message, so `pnpm test:integration` is SAFE to run without a database.
//   2. ISOLATION — insert fresh better-auth `user` rows directly (the FK target
//      for `groups.created_by` / `members.user_id`) with unique ids, and clean up
//      ONLY this suite's own rows in FK-safe order. Every id this suite creates is
//      prefixed `it39-` so cleanup can target exactly our rows and never the
//      seeded `currencies` table or any real data.
//
// The DB env is set by `./setup.ts` (the project's `setupFiles`) BEFORE this
// module — and the app `db` — is imported.

import { sql } from 'drizzle-orm';
import { describe } from 'vitest';
import { db } from '$lib/server/db';
import { user } from '$lib/server/db/auth-schema';

/** Common id/email prefix so cleanup only ever touches THIS suite's rows. */
export const IT_PREFIX = 'it39-';

/** A monotonic counter for unique ids within a single test process. */
let seq = 0;
/** Unique, suite-prefixed id (e.g. for users / display names). */
export function uniqueId(label = 'id'): string {
	seq += 1;
	return `${IT_PREFIX}${label}-${Date.now().toString(36)}-${seq}`;
}

/**
 * Probe connectivity ONCE at module load (top-level await blocks the importing
 * test module, so the result is known before `describeIntegration` is evaluated
 * at collection time). We verify a live connection AND that the Phase-3 tables
 * exist, so a reachable-but-unmigrated DB is reported as "not ready" rather than
 * failing every test with a cryptic missing-relation error.
 */
async function probeDb(): Promise<{ ok: boolean; reason?: string }> {
	try {
		await db.execute(sql`select 1`);
	} catch (e) {
		return { ok: false, reason: `Postgres unreachable (${(e as Error).message})` };
	}
	try {
		const res = await db.execute(sql`
			select
				to_regclass('public.groups')       as groups,
				to_regclass('public.members')      as members,
				to_regclass('public.invites')      as invites,
				to_regclass('public.currencies')   as currencies,
				to_regclass('public."user"')       as users,
				-- Phase-4 ledger + audit tables. The audit integration suite (task 6.4)
				-- drives the transaction services, which need these migrated; checking
				-- them here keeps the integration run safe on a DB that has only the
				-- Phase-3 tables (the whole suite skips cleanly instead of erroring with
				-- a missing-relation). The existing Phase-3 suites are unaffected: the
				-- migrated DB always has these too.
				to_regclass('public.audit_log')    as audit_log,
				to_regclass('public.transactions') as transactions,
				to_regclass('public.categories')   as categories,
					-- Phase-5 public-API tables. The /api/v1 boundary suites (issue #25)
					-- mint real keys, replay idempotent creates and exhaust the per-key
					-- rate limiter, so all three must be migrated; checking them here keeps
					-- the integration run SAFE on an older DB (the suite skips cleanly
					-- instead of erroring with a missing-relation).
					to_regclass('public.api_key')                  as api_key,
					to_regclass('public.idempotency_key')          as idempotency_key,
					to_regclass('public.api_key_class_rate_limit') as api_key_class_rate_limit
		`);
		const row = (res.rows?.[0] ?? {}) as Record<string, unknown>;
		const missing = Object.entries(row)
			.filter(([, v]) => v == null)
			.map(([k]) => k);
		if (missing.length > 0) {
			return {
				ok: false,
				reason: `schema not migrated (missing tables: ${missing.join(', ')}). Run \`pnpm db:migrate\`.`
			};
		}
		// `categories` must also be SEEDED (task 4.3) — `createTransaction` asserts the
		// chosen category id physically exists, so an empty table would fail the audit
		// suite's transaction tests. Treat un-seeded as "not ready" (skip, don't error).
		const seed = await db.execute(sql`select count(*)::int as n from categories`);
		const n = Number((seed.rows?.[0] as { n?: number } | undefined)?.n ?? 0);
		if (n === 0) {
			return {
				ok: false,
				reason: 'categories not seeded. Run `pnpm db:migrate` (the 4.3 seed migration).'
			};
		}
	} catch (e) {
		return { ok: false, reason: `schema check failed (${(e as Error).message})` };
	}
	return { ok: true };
}

const probe = await probeDb();

/**
 * `describe` that runs the block ONLY when the local Postgres is reachable AND
 * migrated; otherwise it's `describe.skip` with the reason appended to the label
 * (visible in the Vitest output) so a DB-less run is green and self-explaining.
 */
export const describeIntegration: (name: string, fn: () => void) => void = probe.ok
	? (name, fn) => describe(name, fn)
	: (name, fn) => describe.skip(`${name} [skipped: ${probe.reason}]`, fn);

/** Insert a fresh better-auth user row directly and return its id. */
export async function createTestUser(label = 'user'): Promise<{ id: string; name: string }> {
	const id = uniqueId(label);
	const name = `${label}-${seq}`;
	await db.insert(user).values({
		id,
		name,
		email: `${id}@example.test`,
		emailVerified: true
	});
	return { id, name };
}

/**
 * Delete ONLY this suite's rows, in FK-safe order
 * (`invites` → `members` → `groups` → `user`). Scoped by the `it39-` prefix on
 * user ids / emails so we never touch the seeded `currencies` table or real data.
 * Run in `afterEach`/`afterAll` to keep tests independent.
 */
export async function cleanupSuiteRows(): Promise<void> {
	// invites created by our users, OR pointing at groups our users created.
	await db.execute(sql`
		delete from invites
		where created_by like ${IT_PREFIX + '%'}
		   or group_id in (select id from groups where created_by like ${IT_PREFIX + '%'})
	`);
	// members in our groups, OR linked to our users (covers slots claimed by our
	// users in any group this suite created).
	await db.execute(sql`
		delete from members
		where user_id like ${IT_PREFIX + '%'}
		   or group_id in (select id from groups where created_by like ${IT_PREFIX + '%'})
	`);
	// groups our users created.
	await db.execute(sql`delete from groups where created_by like ${IT_PREFIX + '%'}`);
	// finally the users themselves.
	await db.execute(sql`delete from "user" where id like ${IT_PREFIX + '%'}`);
}

export { db };
