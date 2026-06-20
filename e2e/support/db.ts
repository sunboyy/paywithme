import { Client } from 'pg';

/**
 * Postgres test helper for the auth e2e suite (task 2.12, PLAN §13).
 *
 * Email is unconfigured in dev, so the magic link is only console-logged — a
 * browser test can't read it. But the magic-link plugin uses `storeToken:
 * "plain"` (better-auth default), so the RAW token that goes in the URL is
 * stored in the `verification` table:
 *   - `identifier` — the raw token (the `?token=` value the verify URL needs)
 *   - `value`      — JSON `{ "email", "name" }`
 *   - `created_at` — insertion time
 *
 * We intercept by querying Postgres directly (no production-code change, no
 * email transport), match the newest row whose `value`→email equals our test
 * email, and build the verify URL the browser then navigates to.
 *
 * `DATABASE_URL` is read from `process.env` (set by `playwright.config.ts`, which
 * also passes it through to the preview server). No dotenv dependency.
 */

function connectionString(): string {
	const url = process.env.DATABASE_URL;
	if (!url) {
		throw new Error(
			'DATABASE_URL is not set for the e2e test process. It is normally provided by playwright.config.ts; export it if running specs directly.'
		);
	}
	return url;
}

/** Run a callback with a short-lived connected `pg` client, always closing it. */
async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
	const client = new Client({ connectionString: connectionString() });
	await client.connect();
	try {
		return await fn(client);
	} finally {
		await client.end();
	}
}

interface VerificationRow {
	identifier: string;
	value: string;
}

/** Parse the magic-link `verification.value` JSON, tolerating malformed rows. */
function emailFromValue(value: string): string | undefined {
	try {
		const parsed = JSON.parse(value) as { email?: unknown };
		return typeof parsed.email === 'string' ? parsed.email : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Return the raw magic-link token most recently issued for `email`, or
 * `undefined` if none exists yet. Newest-first so a reused mailbox is
 * unambiguous (tests use a unique email per run anyway).
 */
export async function getLatestMagicLinkToken(email: string): Promise<string | undefined> {
	return withClient(async (client) => {
		// Scan newest-first; match on the email embedded in `value`. The set is
		// tiny in a test DB, so an in-process filter is simpler than JSON SQL.
		const { rows } = await client.query<VerificationRow>(
			'SELECT identifier, value FROM verification ORDER BY created_at DESC LIMIT 50'
		);
		const match = rows.find((row) => emailFromValue(row.value) === email);
		return match?.identifier;
	});
}

/**
 * Poll for the latest magic-link token for `email` and return the full verify
 * URL the browser should hit:
 *   `<baseURL>/api/auth/magic-link/verify?token=<token>&callbackURL=/auth/magic-link`
 *
 * The handler is mounted at `/api/auth`; the plugin's verify path is
 * `/magic-link/verify`. `callbackURL` mirrors what `/register` and `/login`
 * send so verification lands on the app's magic-link landing route.
 *
 * Polls briefly because the row is written during the form action that the test
 * just submitted — it's usually present immediately, but a couple of retries
 * absorb any lag without flaking.
 */
export async function getLatestMagicLinkUrlFor(
	email: string,
	options: { baseURL: string; callbackURL?: string; timeoutMs?: number }
): Promise<string> {
	const callbackURL = options.callbackURL ?? '/auth/magic-link';
	const deadline = Date.now() + (options.timeoutMs ?? 5000);

	for (;;) {
		const token = await getLatestMagicLinkToken(email);
		if (token) {
			const url = new URL('/api/auth/magic-link/verify', options.baseURL);
			url.searchParams.set('token', token);
			url.searchParams.set('callbackURL', callbackURL);
			return url.toString();
		}
		if (Date.now() > deadline) {
			throw new Error(`No magic-link verification row found for ${email} within the timeout.`);
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

/**
 * Hard-delete every group CREATED by the test user (matched by email) so reruns
 * stay isolated. Group `created_by` → user.id uses `restrict` (the default;
 * PLAN §6.3: a user who authored ledger history can't be deleted out from under
 * it), so a user who created any group can't be removed until their groups are
 * gone first. Deleting the group cascades to its members, invites, transactions,
 * and audit rows (those FKs are `onDelete: 'cascade'` to `group_id`), which in
 * turn clears the only other `restrict` user references (transaction.created_by,
 * audit_log.actor_user_id) — so `deleteUserByEmail` then succeeds.
 *
 * Used by the group-flow e2e (task 8.4), whose acting user DOES create groups
 * (unlike the auth spec). Safe to call in `afterAll`; no rows is a no-op.
 */
export async function deleteGroupsCreatedBy(email: string): Promise<void> {
	await withClient(async (client) => {
		await client.query(
			'DELETE FROM groups WHERE created_by IN (SELECT id FROM "user" WHERE email = $1)',
			[email]
		);
	});
}

/**
 * Remove all auth rows for a test user (and their verification tokens) so reruns
 * stay isolated. Matches the user by email and cascades to session/account/
 * passkey via the FK relationships; `verification` rows key on the token, not the
 * user, so we clear those by the email embedded in `value` separately.
 *
 * NOTE: a user who CREATED groups must have those groups removed first (the
 * `groups.created_by` FK is `restrict`) — see `deleteGroupsCreatedBy`.
 *
 * Safe to call in `afterAll`/`afterEach`; a missing user is a no-op.
 */
export async function deleteUserByEmail(email: string): Promise<void> {
	await withClient(async (client) => {
		// Deleting the user cascades to session/account/passkey (better-auth FKs
		// are ON DELETE CASCADE). Verification rows are independent of the user, so
		// clear the ones carrying this email too.
		await client.query('DELETE FROM "user" WHERE email = $1', [email]);
		const { rows } = await client.query<{ id: string; value: string }>(
			'SELECT id, value FROM verification'
		);
		const staleIds = rows.filter((row) => emailFromValue(row.value) === email).map((row) => row.id);
		if (staleIds.length > 0) {
			await client.query('DELETE FROM verification WHERE id = ANY($1::text[])', [staleIds]);
		}
	});
}
