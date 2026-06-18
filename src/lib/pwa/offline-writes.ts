// Shared "disable writes while offline" helper (PLAN §11 / §11.1).
//
// PLAN §11: "No offline creation in v1 … Show a clear 'you're offline' state
// that disables write actions." Rather than re-deriving the same disabled-when-
// offline-OR-submitting logic on every write surface, pages compute it from this
// pure helper and the reactive `network.offline` flag (see `online.svelte.ts`).
//
// PURE + framework-free so it can be unit-tested without a DOM. It returns BOTH
// the `disabled` boolean and an accessible explanation, so the UX is not
// color-only (the button is disabled AND announces why via `aria-describedby` /
// `title`).

/** Human-facing copy for the offline write block — reused by buttons + tooltips. */
export const OFFLINE_WRITE_MESSAGE = "You're offline — changes can't be saved until you reconnect.";

/**
 * Whether a write submit control should be disabled, and why.
 *
 * @param offline   reactive `network.offline` flag (browser-driven).
 * @param submitting the form's existing in-flight flag (optional). Preserves the
 *                   prior "disable while submitting" behavior so callers can
 *                   replace `disabled={$submitting}` with one call.
 * @param force      an extra page-specific disable reason (e.g. nothing to save),
 *                   OR-ed in so this helper never relaxes an existing block.
 */
export function writeDisabled(
	offline: boolean,
	submitting = false,
	force = false
): { disabled: boolean; reason: string | null } {
	if (offline) return { disabled: true, reason: OFFLINE_WRITE_MESSAGE };
	if (submitting || force) return { disabled: true, reason: null };
	return { disabled: false, reason: null };
}
