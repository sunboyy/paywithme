// Postgres driver-error inspection shared across the server (PLAN §4 data layer).
//
// Drizzle wraps every driver failure in a `DrizzleQueryError` whose own `code` is
// undefined and whose `cause` is the `pg` error carrying the actual SQLSTATE (e.g.
// `code: '23505'`). Inspecting only the thrown value therefore MISSES the code
// against real Postgres — the check silently never fires. Every SQLSTATE probe must
// walk the CAUSE CHAIN, which is what this helper does.

/** Postgres SQLSTATE for a unique-violation — a UNIQUE / primary-key constraint trip. */
const UNIQUE_VIOLATION = '23505';

/**
 * Does `e` (or anything in its `cause` chain) carry the Postgres SQLSTATE `code`?
 *
 * Bounded walk — a cause chain is short, and the depth bound rules out a cycle.
 */
function hasPgCode(e: unknown, code: string): boolean {
	for (let current: unknown = e, depth = 0; current != null && depth < 5; depth++) {
		if (typeof current === 'object' && 'code' in current) {
			if ((current as { code: unknown }).code === code) return true;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/**
 * A Postgres unique-violation (`23505`) — a UNIQUE / primary-key constraint was
 * tripped. Looked up along the CAUSE CHAIN, not just on the thrown value, because
 * Drizzle wraps the driver error (see the module header). Only a real-DB test can
 * catch a regression here — a stubbed store throws whatever it is told to.
 */
export function isUniqueViolation(e: unknown): boolean {
	return hasPgCode(e, UNIQUE_VIOLATION);
}
