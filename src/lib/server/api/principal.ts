// Resolved API-key principal (PLAN §16.3, §16.4).
//
// The minimal identity the `/api/v1/*` auth guard (`hooks.server.ts`) attaches
// to `event.locals.apiKey` after a successful `verifyApiKey`. Deliberately small:
// it carries only what later per-route authorization (the §16.2 scope
// write-guard, a LATER ticket) needs — the owning user and the key's scope — not
// the whole plugin key record. Kept in its own module so both `hooks.server.ts`
// and the ambient `app.d.ts` reference ONE source of truth without importing the
// `.server` hook file into ambient types.
export interface ApiKeyPrincipal {
	/** The API key's own id (audit / rate-limit correlation). */
	keyId: string;
	/**
	 * The key's human label (the plugin's nullable `name`). Carried purely as AUDIT
	 * PROVENANCE (§16.2): it is denormalized into the audit row's summary suffix +
	 * `metadata.keyName` so an old entry stays readable after the key is revoked and
	 * gone. Never used for authentication or authorization.
	 */
	name: string | null;
	/**
	 * The id of the user that owns the key. The api-key plugin stores the owner
	 * under `referenceId` (references = user); we surface it as `userId` because
	 * that is what downstream per-route guards reason about.
	 */
	userId: string;
	/**
	 * The key's scope, as stored by the plugin: a map of resource → actions.
	 * `null` when the key carries no explicit permissions. Read by the §16.2
	 * per-route write-guard (a LATER ticket) — never for authentication here.
	 */
	permissions: Record<string, string[]> | null;
	/**
	 * OAUTH PROVENANCE (ADR-0010 §Consequences; #42) — the raw OAuth client id (the
	 * registered CONNECTED APP, e.g. Claude.ai's connector), present ONLY when this
	 * principal was resolved from an OAuth access token (`mcp/auth.ts`
	 * `resolveOAuthPrincipal`). ABSENT (`undefined`) on the API-key path (`/api/v1`
	 * `verify.ts`, and the api-key MCP fallback) — that absence is exactly how audit
	 * provenance tells an OAuth-originated mutation (`viaOAuth`) from a key-driven one
	 * (`viaKey`). This is the RAW `clientId`, NOT the composed `${clientId}:${userId}`
	 * `keyId` (which folds in the user for per-caller isolation); the actor tag records
	 * WHICH APP a change entered through, so it must be the client id alone. Carried as
	 * AUDIT PROVENANCE only — never used for authentication or authorization.
	 */
	oauthClientId?: string;
}
