<script lang="ts" module>
	/**
	 * One open Capture as the tray renders it (issue #50; PLAN §7.7).
	 *
	 * The amount arrives ALREADY FORMATTED (or `null`): it is stored uninterpreted —
	 * no rate, no conversion, no settlement equivalent (§7.7 "Edge cases") — and the
	 * one thing needed to render it is the exponent of a currency that may exist only
	 * as a `currencies` row. The server holds that; the tray does not need to.
	 */
	export type TrayCapture = {
		id: string;
		/** MEMBER-AUTHORED TEXT (CONTEXT.md) — rendered as text, never as markup. */
		note: string;
		/** Who wrote it. Attribution is what makes the tray deduplicate (§7.7). */
		authorName: string;
		/** e.g. "฿1,200.00", or `null` for a note-only Capture. */
		amountFormatted: string | null;
		/** The real-world day (`YYYY-MM-DD`) the expense happened. */
		capturedFor: string;
		/**
		 * Where "Record it" goes — the add-transaction form, prefilled from this note
		 * (issue #51; PLAN §7.7 "Resolving"). Built by the page, which owns route
		 * knowledge; a plain link, so it works with no JS and can be opened in a new tab.
		 */
		recordHref: string;
	};
</script>

<script lang="ts">
	// The "Not recorded yet" tray (issue #50; PLAN §7.7 "Recall (no push)", §10).
	//
	// Sits ABOVE the transaction list and shows the group's open Captures, newest
	// first, each attributed to its author. The attribution is not decoration: the
	// tray exists to DEDUPLICATE, and "Sur — dinner, ~฿1,200" is what stops the
	// second person who paid part of that dinner recording it a second time.
	//
	// ── MEMBER-AUTHORED TEXT ─────────────────────────────────────────────────────
	// `note` is written by a member (CONTEXT.md). It is interpolated as TEXT — never
	// `{@html}` — so Svelte escapes it, and it is always shown next to who wrote it.
	//
	// ── THE TWO ENDINGS ──────────────────────────────────────────────────────────
	// "Record it" (#51) is a LINK to the add-transaction form prefilled from the
	// note, not a form action: recording needs the split, the payers and the category
	// that the note deliberately doesn't hold (ADR-0012), so the ending is decided on
	// that form and stamped when it saves. "Discard" is the other ending, and it IS a
	// destructive form action — hence the dialog on top of it.
	//
	// The word "Capture" appears nowhere a user can read — internal vocabulary
	// (PLAN §7.7 / CONTEXT.md).
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
	import { dayLabel } from '$lib/date-groups';

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type EnhanceAction = (node: HTMLFormElement, param?: any) => { destroy?(): void } | void;

	let {
		captures,
		discardAction,
		enhance
	}: {
		captures: readonly TrayCapture[];
		/** The form action the discard posts to, e.g. `?/discard`. */
		discardAction: string;
		/** `use:enhance` for the discard form — progressive enhancement only. */
		enhance: EnhanceAction;
	} = $props();

	/**
	 * `capturedFor` is a DATE (`YYYY-MM-DD`), not an instant. `new Date('2026-09-05')`
	 * parses as UTC midnight, which is the PREVIOUS day west of Greenwich — so the
	 * time part is appended to force LOCAL midnight and the day the member picked is
	 * the day they read back.
	 */
	function whenLabel(capturedFor: string): string {
		return dayLabel(`${capturedFor}T00:00:00`);
	}
</script>

{#if captures.length > 0}
	<Card.Root data-testid="not-recorded-yet-tray" class="border-dashed">
		<Card.Header class="pb-2">
			<Card.Title class="text-base">Not recorded yet</Card.Title>
			<Card.Action>
				<Badge variant="secondary">{captures.length}</Badge>
			</Card.Action>
		</Card.Header>
		<Card.Content>
			<ul class="divide-y divide-border" aria-label="Not recorded yet">
				{#each captures as capture (capture.id)}
					<li class="flex items-start justify-between gap-3 py-2">
						<div class="min-w-0 flex-1">
							<!-- Member-authored text, escaped by interpolation. `wrap-break-word`
							     rather than truncation: the note IS the content. -->
							<p class="text-sm wrap-break-word">{capture.note}</p>
							<p class="text-xs text-muted-foreground">
								<span class="font-medium">{capture.authorName}</span>
								·
								{whenLabel(capture.capturedFor)}
								{#if capture.amountFormatted}
									<!-- "~" because the amount is a rough note, not a ledger figure:
									     nothing that computes a balance can see it (§7.7). -->
									· ~{capture.amountFormatted}
								{/if}
							</p>
						</div>
						<!-- Mobile-first (§10): the two endings stack on a narrow screen so the
						     note itself keeps the width, and sit side by side from `sm` up. -->
						<div class="flex shrink-0 flex-col items-stretch gap-1 sm:flex-row sm:items-center">
							<!-- The primary ending: opens the add-transaction form prefilled from
							     this note (§7.7 "Resolving"). -->
							<Button variant="secondary" size="sm" href={capture.recordHref}>Record it</Button>
							<!-- Destructive, so it is confirmed by an Alert Dialog naming the note
							     (§10) — and the underlying form action still works without JS. -->
							<ConfirmSubmit
								action={discardAction}
								{enhance}
								hiddenName="captureId"
								hiddenValue={capture.id}
								triggerLabel="Discard"
								title="Discard this note?"
								description="“{capture.note}” will stop showing here. It won't be recorded, and the group's activity keeps a record that it was discarded."
								confirmLabel="Discard"
							/>
						</div>
					</li>
				{/each}
			</ul>
		</Card.Content>
	</Card.Root>
{/if}
