// The canonical form of a member display name — the value stored in
// `members.normalized_display_name` and compared by the active-member uniqueness
// index (ADR-0015; PLAN §6.1–§6.3, §9).
//
// ── Why the app computes it, not the database ────────────────────────────────
// The rule starts with Unicode NFC composition, and the design pinned by ADR-0015
// is a plain, app-written column rather than a DB-side generated expression: the
// rule then lives in ONE language, next to the code that also has to resolve a
// name back to a member (the MCP write tools, issue #76+), so the write path and
// the lookup path cannot drift into two slightly different notions of "same name".
// The only DB-side use is the one-shot backfill in the migration that introduces
// the column.
//
// ── The rule ─────────────────────────────────────────────────────────────────
// NFC → trim → lowercase, over the FULL string. Nothing else: no accent folding,
// no whitespace squeezing, no punctuation stripping. `  Nan  ` and `nan` are the
// same member name; `Nan Suphaporn` and `Nan` are not.
//
// This is deliberately NOT `similar-names.ts`'s rule. That module answers a
// different question — "could the agent have MEANT someone else?" — with a
// first-token PREFIX match, which is a similarity HINT and a judgement call. This
// is an EQUALITY test backing a database constraint, so it compares whole strings.
// The two share their first three steps (and this function is where those steps
// live, so a change to one is a change to both) and diverge exactly at the token
// split, which only the hint applies.
//
// Plain `toLowerCase` (not `toLocaleLowerCase`) is deliberate, for the same reason
// `similar-names.ts` states: the stored key must be identical on every server, and
// a locale-dependent fold would make a row's canonical form depend on where the
// process that wrote it happened to run.

/**
 * The canonical comparison form of a display name: NFC → trim → lowercase, full
 * string. PURE.
 *
 * An all-whitespace name normalizes to `''`. Nothing here rejects that — the
 * empty case is `memberDisplayNameField`'s job (`$lib/schemas/member`), which
 * requires at least one non-whitespace character before a name ever reaches the
 * database. Note `''` is still a perfectly valid key for the unique index: two
 * blank active names in one group would collide, which is the right answer.
 */
export function normalizeDisplayName(name: string): string {
	return name.normalize('NFC').trim().toLowerCase();
}

/**
 * The `members` name columns for an insert/update, as one object to spread:
 *
 * ```ts
 * tx.insert(members).values({ groupId, ...displayNameValues(name) })
 * ```
 *
 * Every write of `display_name` MUST go through this, so the stored key can never
 * fall out of step with the name it describes — a stale key would silently defeat
 * the uniqueness index (a duplicate would be accepted because the two rows'
 * *stored* keys differ). Keeping the pair in one object is what makes forgetting
 * the second column hard.
 *
 * The name itself is stored EXACTLY as given (the display form is the user's; the
 * schema's `.trim()` already ran at the boundary) — only the derived key is folded.
 */
export function displayNameValues(displayName: string): {
	displayName: string;
	normalizedDisplayName: string;
} {
	return { displayName, normalizedDisplayName: normalizeDisplayName(displayName) };
}

/**
 * The nth name in the auto-suffix family for `base`: `1` is the base name ITSELF,
 * then `Nan (2)`, `Nan (3)`, … (ADR-0015). PURE.
 *
 * The base is passed through verbatim at `n === 1` — the display form belongs to
 * the user and nothing here should rewrite it (same rule as `displayNameValues`).
 * A numbered name is built from the trimmed, NFC form instead, so a padded base
 * can't produce `'Nan  (2)'`; the padding would be invisible in the rendered name
 * yet permanently baked into the suffixed one.
 */
function suffixedDisplayName(base: string, n: number): string {
	return n === 1 ? base : `${base.normalize('NFC').trim()} (${n})`;
}

/**
 * The first name in `base`'s suffix family — `Nan`, `Nan (2)`, `Nan (3)`, … — whose
 * canonical key is NOT in `takenNormalized`. PURE.
 *
 * This is the auto-suffix rule ADR-0015 gives to invite-accept, where the joiner
 * did not choose the colliding name in the moment and must never be refused entry
 * over a name coincidence. It is deliberately NOT used by the admin writes
 * (add / rename / reactivate), which hard-reject: there the name IS in hand and
 * can be retyped.
 *
 * `takenNormalized` holds NORMALIZED keys (what the uniqueness index compares), so
 * `nan` blocks `Nan`. Callers build it from the group's ACTIVE members only —
 * deactivated members are exempt from the index and must not burn a number.
 *
 * Terminates: the set is finite, so at most `size + 1` candidates are tried.
 *
 * A base that already looks suffixed is not special-cased — a user genuinely named
 * `Nan (2)` colliding with an active `Nan (2)` becomes `Nan (2) (2)`. Ugly and
 * vanishingly rare, and the joiner can rename themselves afterwards; unwinding an
 * existing `(n)` would instead risk handing them a DIFFERENT person's name.
 */
export function nextFreeDisplayName(base: string, takenNormalized: ReadonlySet<string>): string {
	for (let n = 1; ; n++) {
		const candidate = suffixedDisplayName(base, n);
		if (!takenNormalized.has(normalizeDisplayName(candidate))) {
			return candidate;
		}
	}
}
