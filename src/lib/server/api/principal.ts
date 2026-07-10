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
}
