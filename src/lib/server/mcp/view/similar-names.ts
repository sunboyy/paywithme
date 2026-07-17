// The "other Nan" check — a POST-WRITE, PURELY PRESENTATIONAL roster scan
// (ADR-0006, issue #34).
//
// ── What problem this solves, and what it must never become ──────────────────
// The server already rejects a HALLUCINATED member id. The residual failure is
// worse because it is valid: an agent matching the user's "Nan" against a roster
// holding both `Nan Suphaporn` and `Nanthawat P.` can pick the WRONG REAL PERSON,
// and that write passes every guard while misattributing money between two humans.
//
// ADR-0006's control for this is LEGIBILITY, NOT PREVENTION: "We do not stop the
// agent picking wrong; we make a wrong pick something the user reads in plain
// language before they walk away." This module is that reading — it names the OTHER
// person the agent might have meant, so the mistake is caught in the transcript
// instead of in a dispute weeks later.
//
// So, the hard boundary, restated because it is the whole reason this file is not in
// the money path: **this runs AFTER the write, against the id the agent ALREADY
// supplied, and its output is prose.** It never selects, ranks, suggests or corrects
// a payee. ADR-0006 forbids server-side fuzzy name matching in the money path — the
// agent matches the name itself, visibly, in the transcript. Nothing here may ever be
// fed back into a `from`/`to` decision; if a future caller wants that, it is a new
// ADR, not a new import. (The signature enforces the shape of that promise: it takes
// an ALREADY-DECIDED `targetId` and returns members who were NOT involved.)
//
// ── The similarity rule, stated plainly, and owned as a judgement call ───────
// Two names COLLIDE when the normalized first token of one is a PREFIX of the
// normalized first token of the other (identical names included, since a name is a
// prefix of itself). `nan` ⊂ `nanthawat` → collide; `nan` vs `bob` → no.
//
// Normalization = NFC → trim → lowercase → take the text before the first run of
// whitespace. Nothing else. NO edit distance, NO phonetics, NO transliteration: this
// is a legibility hint on a page the user is already reading, and a cheap, obvious,
// stated rule is worth more than an accurate opaque one.
//
// The rule is a JUDGEMENT CALL, not a derived truth (the same way ADR-0005's 60s
// window is). It is tuned for the failure the ADR actually names — a user saying a
// SHORT FORM of a longer name — which is why it is a prefix rule on the first token
// rather than a substring or fuzzy rule. Its known misses are deliberate: `Nan` vs
// `Suphaporn Nan` (the collision is in the SECOND token) does not fire, and neither
// does a nickname bearing no textual relation to the name on the roster. Its known
// over-fires (`A` vs `Alice`) cost one extra clause of prose and nothing else. If
// real usage shows the wrong balance of the two, THIS is the dial.
//
// ── Why "first token", in an app that is Thai-facing ─────────────────────────
// Splitting on whitespace is NOT an assumption that names are ASCII or that given
// names are space-separated. A Thai full name written without an internal space
// simply yields ONE token — the whole name — and the rule degrades to comparing full
// names by prefix, which is exactly right for a script that does not delimit them.
// The split is an opportunistic narrowing where it applies, never a requirement.
//
// Odd input must never throw and never spray: an empty-ish name normalizes to `''`,
// and `''` is a prefix of everything, which would collide with the entire roster. So
// an empty key on EITHER side is excluded outright (see `matchKey`).

import type { MemberView } from './member';
import type { UntrustedText } from './untrusted';

/**
 * A member the write did NOT involve, whose name could be confused with the one it
 * did. `displayName` stays the untrusted envelope it already was (ADR-0003) — this
 * module never unwraps a name it merely re-lists.
 */
export interface SimilarMemberView {
	readonly memberId: string;
	/** UNTRUSTED (ADR-0003) — member-authored, author `unknown`. */
	readonly displayName: UntrustedText;
}

/**
 * The comparison key for one display name: NFC → trim → lowercase → the text before
 * the first run of whitespace. `''` for a name with no usable text, which callers
 * MUST treat as "never collides" rather than "collides with everything".
 *
 * Plain `toLowerCase` (not the locale-aware form) is deliberate: the result must be
 * identical on every server, and a locale-dependent fold would make this hint's
 * output depend on where the process happens to run.
 */
function matchKey(name: string): string {
	const normalized = name.normalize('NFC').trim().toLowerCase();
	// `split` always yields at least one element; `?? ''` is for the type, not the case.
	return normalized.split(/\s+/u)[0] ?? '';
}

/** Whether two normalized keys collide: either is a prefix of the other. Both non-empty. */
function collides(a: string, b: string): boolean {
	if (a === '' || b === '') return false;
	return a.startsWith(b) || b.startsWith(a);
}

/**
 * The ACTIVE members whose display name could be confused with `targetId`'s, minus
 * the target and anyone in `excludeIds`. PURE, O(members), no I/O. Returns `[]` when
 * there is nothing to say — the common case, and the only case in which the caller
 * must stay silent (see the echo: a note on every write would be noise, and noise is
 * what teaches a model to skip the line that matters).
 *
 * DEACTIVATED members are excluded (§6.3): they cannot be a party to a NEW
 * transaction, so "did you mean them?" points at something that could not have
 * happened. The note is here to flag a mistake the agent COULD have made.
 *
 * An unknown `targetId` (not on this roster) yields `[]` — this is a hint, and it has
 * nothing to hint about a member it cannot see.
 */
export function similarlyNamedMembers({
	members,
	targetId,
	excludeIds = []
}: {
	readonly members: readonly MemberView[];
	/**
	 * The member the write ALREADY named — decided by the agent, never by this
	 * module. We describe that decision; we do not participate in it.
	 */
	readonly targetId: string;
	/** Members to leave out — typically the payer, already named in the prose. */
	readonly excludeIds?: readonly string[];
}): SimilarMemberView[] {
	const target = members.find((m) => m.id === targetId);
	if (!target) return [];

	const key = matchKey(target.displayName.value);
	if (key === '') return [];

	const skip = new Set([targetId, ...excludeIds]);
	return members
		.filter((m) => !skip.has(m.id) && m.isActive && collides(key, matchKey(m.displayName.value)))
		.map((m) => ({ memberId: m.id, displayName: m.displayName }));
}
