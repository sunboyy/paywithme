// API-key management service (PLAN §16.8; CLAUDE.md: "Business logic in
// lib/server/").
//
// The testable core behind the Settings API-keys section: list / create / revoke,
// each mapped onto the `@better-auth/api-key` plugin's SERVER API (never its HTTP
// endpoints — PLAN §16.1), plus the two `audit_log` rows §16.8 requires.
//
// ── Why the plugin owns the key row, and what that means for the audit write ──
// CLAUDE.md's rule is "every mutation writes an audit_log row in the SAME DB
// transaction". Here the mutation itself happens INSIDE the plugin
// (`auth.api.createApiKey` / `deleteApiKey` go through better-auth's own adapter),
// so there is no transaction handle for us to join — a hard constraint of using
// the plugin, which §16.1 mandates. We therefore do the next-best, deliberately
// ordered thing:
//   - CREATE:  mint first, then write the audit row. If the audit write fails the
//              key exists but is unlogged — so we surface the failure to the
//              caller rather than swallowing it, and the reveal screen is still
//              reached only on a fully successful create.
//   - REVOKE:  audit row FIRST would be a lie if the delete then failed, so we
//              delete first and audit after, same as create.
// Every audit row still goes through `writeAuditLog(tx, …)` inside a real
// `db.transaction(...)` — the ONE audit-write mechanism (PLAN §12.1); we never
// insert into `audit_log` directly.
//
// ── Account-level audit rows ──────────────────────────────────────────────────
// An API key belongs to a USER, not a group, so these rows carry `groupId: null`
// (the column is nullable for exactly this case — see `db/audit-schema.ts`) and
// `entityType: 'api_key'`. Per §16.2 the actor is the USER id, and the key id goes
// in `metadata`. These creates/revokes happen from the WEB SESSION, so they
// deliberately do NOT use the `via` provenance path (that suffix is only for
// mutations DRIVEN BY a key over `/api/v1`).

import { db } from './db';
import { auth } from './auth';
import { writeAuditLog } from './audit';
import { getApiKeyScope, scopeToPermissions, type ApiScope } from './api/scope';
import type { CreateApiKeyInput } from '$lib/schemas/api-key';

/** Thrown when a key id doesn't exist, or isn't the caller's to touch. */
export class ApiKeyNotFoundError extends Error {
	constructor(message = 'API key not found') {
		super(message);
		this.name = 'ApiKeyNotFoundError';
	}
}

const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * The key label used in a summary/metadata when the key carries no name. The
 * create form requires a name, so this only guards keys minted outside the form.
 */
export const UNNAMED_KEY_LABEL = 'unnamed';

/** One row of the Settings key list — never the secret, only the safe `start`. */
export type ApiKeyListItem = {
	id: string;
	/** The user's label (the plugin allows null). */
	name: string | null;
	/** `read` | `write`, decoded from the plugin's `permissions` (PLAN §16.2). */
	scope: ApiScope;
	/** The first few plaintext chars incl. the prefix — SAFE to display (§16.1). */
	start: string | null;
	/** ISO strings so everything serializes cleanly to the client. */
	createdAt: string;
	/** Plugin `lastRequest` → "last used"; null until the key is first used. */
	lastRequest: string | null;
	/** Null = never expires (the default, §16.2). */
	expiresAt: string | null;
	/** Pre-computed server-side so the list can style expired keys distinctly. */
	expired: boolean;
};

/** What a successful create hands back — the plaintext is shown exactly once. */
export type CreatedApiKey = {
	id: string;
	name: string | null;
	scope: ApiScope;
	start: string | null;
	expiresAt: string | null;
	/** THE SECRET. Returned by the plugin only at creation; never stored in clear. */
	key: string;
};

/**
 * Translate the form's expiry choice into the plugin's `expiresIn` SECONDS
 * (PLAN §16.8: Never-default + 30/90/365 presets + custom).
 *
 * PURE — the whole preset/custom rule in one testable place. Returns `undefined`
 * for "never", which is what makes the key non-expiring: the plugin only sets
 * `expiresAt` when `expiresIn` is truthy, so omitting it leaves `expiresAt` NULL
 * (§16.2 "non-expiring by default").
 *
 * `customDays` is read ONLY when the choice is `custom`, so a leftover value in
 * the custom input can never shorten a "never" key's life. The schema has already
 * guaranteed it is present and within the plugin's 1–365-day bounds.
 */
export function expiresInSeconds(
	input: Pick<CreateApiKeyInput, 'expiry' | 'customDays'>
): number | undefined {
	if (input.expiry === 'never') return undefined;
	const days = input.expiry === 'custom' ? input.customDays : Number(input.expiry);
	if (days === undefined || !Number.isFinite(days) || days <= 0) return undefined;
	return days * SECONDS_PER_DAY;
}

/**
 * Mask a freshly-minted secret for the reveal banner (PLAN §16.8): keep the
 * human-recognizable head (the `pwm_test_` / `pwm_live_` prefix + a few chars)
 * and replace the rest with dots. PURE, so the reveal screen renders a masked
 * value SERVER-SIDE — the no-JS default state shows the mask, and the full secret
 * only appears behind the show toggle.
 */
export function maskApiKeySecret(secret: string, visibleChars = 12): string {
	if (secret.length <= visibleChars) return secret;
	return `${secret.slice(0, visibleChars)}${'•'.repeat(Math.min(secret.length - visibleChars, 24))}`;
}

/** Normalize a plugin date field (Date | string | null) to an ISO string. */
function toIso(value: Date | string | null | undefined): string | null {
	if (!value) return null;
	const d = value instanceof Date ? value : new Date(value);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The key fields we read back from the plugin. Declared structurally (rather than
 * importing the plugin's `ApiKey`) because `listApiKeys` and `createApiKey` return
 * slightly different shapes of the same row and both satisfy this.
 */
type PluginKeyRow = {
	id: string;
	name?: string | null;
	start?: string | null;
	permissions?: Record<string, string[]> | null;
	createdAt: Date | string;
	lastRequest?: Date | string | null;
	expiresAt?: Date | string | null;
};

/** Map a plugin row → the list item the UI renders. Exported for its unit test. */
export function toApiKeyListItem(row: PluginKeyRow, now: Date = new Date()): ApiKeyListItem {
	const expiresAt = toIso(row.expiresAt);
	return {
		id: row.id,
		name: row.name ?? null,
		// One decoder for the whole app — the same `permissions` reader the /api/v1
		// write-guard uses (§16.2), so the badge can never disagree with enforcement.
		scope: getApiKeyScope({ permissions: row.permissions ?? null }),
		start: row.start ?? null,
		createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
		lastRequest: toIso(row.lastRequest),
		expiresAt,
		expired: expiresAt !== null && new Date(expiresAt).getTime() <= now.getTime()
	};
}

/**
 * List the caller's own keys, newest first (PLAN §16.8).
 *
 * Goes through the plugin's session-authenticated `listApiKeys`, so it physically
 * cannot return another user's keys: the endpoint derives the owner from the
 * session in `headers`, not from anything we pass. The plaintext secret is not in
 * the row (only the hash, which the plugin strips) — only the safe `start`.
 */
export async function listApiKeysForUser({
	headers
}: {
	headers: Headers;
}): Promise<ApiKeyListItem[]> {
	const result = await auth.api.listApiKeys({ headers, query: {} });
	const rows: PluginKeyRow[] = Array.isArray(result) ? result : (result?.apiKeys ?? []);
	const now = new Date();
	return rows
		.map((row) => toApiKeyListItem(row, now))
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Mint a key for `userId` (PLAN §16.8) and record the create in the audit trail.
 *
 * The plaintext is returned by the plugin EXACTLY ONCE, here — it is hashed at
 * rest (§16.1) and can never be recovered, which is what the reveal screen's
 * "you won't see this again" warning is about. The caller must hand it straight to
 * the one-time reveal and never persist or log it.
 *
 * NOTE the deliberate absence of `headers`: the plugin treats a request WITH
 * headers as a "client request" and then REJECTS server-only properties —
 * `permissions` is one of them. Scopes are the whole money-safety story (§16.2),
 * so we call the server-side path (`body.userId`, no headers) with the session
 * user id the route already resolved.
 */
export async function createApiKeyForUser({
	userId,
	input
}: {
	userId: string;
	input: CreateApiKeyInput;
}): Promise<CreatedApiKey> {
	const scope: ApiScope = input.scope;
	const created = await auth.api.createApiKey({
		body: {
			name: input.name,
			userId,
			// `{ api: ['read'] }` / `{ api: ['read','write'] }` — the exact encoding
			// `getApiKeyScope` / the /api/v1 write-guard read back (§16.2).
			permissions: scopeToPermissions(scope),
			// `undefined` ⇒ never expires (§16.2 default). Presets/custom → seconds.
			expiresIn: expiresInSeconds(input)
		}
	});

	const expiresAt = toIso(created.expiresAt);

	// Audit row (PLAN §16.8): actor = the USER, key id in `metadata` (§16.2).
	// Account-level ⇒ `groupId: null`. Written through the one audit mechanism,
	// inside a real transaction. NOT the `via` path — this is a web-session action,
	// not an API-key-driven mutation, so it gets no "(via API key …)" suffix.
	await db.transaction(async (tx) => {
		await writeAuditLog(tx, {
			groupId: null,
			actorUserId: userId,
			action: 'create',
			entityType: 'api_key',
			entityId: created.id,
			summary: `Created API key '${created.name ?? UNNAMED_KEY_LABEL}' (${scope} access)`,
			metadata: {
				keyId: created.id,
				keyName: created.name ?? null,
				scope,
				expiresAt
			}
		});
	});

	return {
		id: created.id,
		name: created.name ?? null,
		scope,
		start: created.start ?? null,
		expiresAt,
		key: created.key
	};
}

/**
 * Revoke (delete) one of the caller's own keys (PLAN §16.2: revoke = delete → the
 * key returns an immediate 401 on its next request) and audit it.
 *
 * OWNERSHIP is enforced by the plugin, twice over: both `getApiKey` and
 * `deleteApiKey` run under `sessionMiddleware` and 404 when the key's
 * `referenceId` isn't the session user — so a forged id from another user's
 * account cannot be revoked here, and we don't need (and must not add) our own
 * ownership check on top. We read the key FIRST only to capture its name for the
 * durable audit summary, since after the delete it is gone for good.
 */
export async function revokeApiKeyForUser({
	userId,
	keyId,
	headers
}: {
	userId: string;
	keyId: string;
	headers: Headers;
}): Promise<{ id: string; name: string | null }> {
	let name: string | null = null;
	try {
		const existing = await auth.api.getApiKey({ query: { id: keyId }, headers });
		name = existing?.name ?? null;
	} catch {
		// Absent OR not ours — conflated, exactly like the rest of the app's
		// not-found discipline (never leak that someone else's key exists).
		throw new ApiKeyNotFoundError();
	}

	try {
		await auth.api.deleteApiKey({ body: { keyId }, headers });
	} catch {
		throw new ApiKeyNotFoundError();
	}

	// Audit row (PLAN §16.8) — same account-level shape as create. The `summary` is
	// durable: the key row is hard-deleted, so the name only survives here.
	await db.transaction(async (tx) => {
		await writeAuditLog(tx, {
			groupId: null,
			actorUserId: userId,
			action: 'revoke',
			entityType: 'api_key',
			entityId: keyId,
			summary: `Revoked API key '${name ?? UNNAMED_KEY_LABEL}'`,
			metadata: { keyId, keyName: name }
		});
	});

	return { id: keyId, name };
}
