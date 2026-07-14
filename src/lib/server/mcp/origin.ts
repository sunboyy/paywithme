// `Origin` validation for `/mcp` — the MCP spec's DNS-rebinding defence
// (ADR-0001: "`Origin` is validated on every request (spec MUST)").
//
// The attack: a page on `evil.example` running in the victim's browser resolves a
// hostname to 127.0.0.1 and POSTs to a locally-reachable MCP server, riding along
// with whatever ambient authority the server trusts. The defence is to refuse any
// request whose `Origin` we did not sanction.
//
// ── Why a MISSING Origin is allowed ──────────────────────────────────────────
// `Origin` is a BROWSER-set header; a browser cannot omit it on a cross-origin
// fetch. The MCP clients we actually target — Claude Code and Cursor (ADR-0007) —
// are not browsers and send no `Origin` at all. Rejecting the absent header would
// therefore break every real client while stopping no attacker: a non-browser
// caller can set any header it likes, so the header only ever carries signal when
// a browser put it there. We validate it whenever it IS present, which is exactly
// the case the rebinding attack needs.
//
// Allowed = the app's own origin (the request's own `url.origin`, plus the
// configured canonical `BETTER_AUTH_URL`), plus anything explicitly listed in
// `MCP_ALLOWED_ORIGINS`. Both functions here are PURE — the route reads env and
// passes values in — so every branch is unit-tested without a request.

/**
 * Parse the `MCP_ALLOWED_ORIGINS` env var: a comma-separated origin list. Blanks
 * are dropped and each entry is trimmed and NORMALIZED through `URL` (so a stray
 * trailing slash or an uppercase host still matches). An unparseable entry is
 * dropped rather than crashing the endpoint — a typo in config must not take
 * `/mcp` down, and dropping it fails CLOSED (the origin simply isn't allowed).
 */
export function parseAllowedOrigins(raw: string | undefined | null): string[] {
	if (!raw) return [];
	return raw
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.map(normalizeOrigin)
		.filter((entry): entry is string => entry !== null);
}

/** `URL`-normalize an origin string (`https://Host.COM/` → `https://host.com`), or null. */
function normalizeOrigin(value: string): string | null {
	try {
		return new URL(value).origin;
	} catch {
		return null;
	}
}

/**
 * Is this request's `Origin` acceptable?
 *
 *   - absent / empty → ALLOWED (a non-browser client: Claude Code, Cursor — see
 *     the module note on why this is not a hole);
 *   - `null` (the literal string a sandboxed/opaque browser context sends) → DENIED;
 *   - otherwise it must normalize to the request's own origin, or to one of
 *     `allowed` (the canonical app origin + `MCP_ALLOWED_ORIGINS`).
 *
 * PURE.
 */
export function isOriginAllowed(
	origin: string | null | undefined,
	selfOrigin: string,
	allowed: readonly string[] = []
): boolean {
	if (origin === null || origin === undefined || origin.trim() === '') return true;

	const candidate = normalizeOrigin(origin.trim());
	// `Origin: null` (an opaque origin — a sandboxed iframe, a `file://` page) is not
	// a URL and must never be trusted.
	if (candidate === null) return false;

	const permitted = [normalizeOrigin(selfOrigin), ...allowed].filter(
		(value): value is string => value !== null
	);
	return permitted.includes(candidate);
}
