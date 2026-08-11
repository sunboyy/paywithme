<script lang="ts">
	// One `audit_log` row as the UI renders it (PLAN §12.1) — the actor, what they
	// did, when, and the server-written summary.
	//
	// Shared by the two surfaces that show audit rows: the group's activity FEED
	// (`/groups/[id]/activity`) and ONE transaction's own HISTORY (the detail page).
	// They differ only in padding and in whether the entity-type badge is worth
	// showing — on a single transaction's history every row is a transaction, so the
	// badge would say the same word on every line. Everything else must match: two
	// renderings of the same audit row that disagree about how a time or a summary
	// reads is exactly the drift the audit trail exists to rule out.
	import { Badge } from '$lib/components/ui/badge';
	import { actionLabel, absoluteTime, relativeTime } from '$lib/activity-labels';
	import type { ActivityEntry } from '$lib/server/activity';

	let {
		entry,
		/** Show the entity-type badge — the group FEED does; a single entity's history doesn't. */
		showEntityType = false,
		/** Row padding, so each surface keeps its own card gutter. */
		class: className = 'p-3'
	}: {
		entry: ActivityEntry;
		showEntityType?: boolean;
		class?: string;
	} = $props();
</script>

<div class="flex flex-col gap-1 {className}">
	<div class="flex items-start justify-between gap-2">
		<p class="min-w-0 text-sm">
			<span class="font-medium">{entry.actorName}</span>
			<span class="text-muted-foreground"> {actionLabel(entry.action)} </span>
			{#if showEntityType}
				<Badge variant="outline" class="ml-1 align-middle capitalize">
					{entry.entityType}
				</Badge>
			{/if}
		</p>
		<!-- Relative time (locale-aware), absolute on hover/title. -->
		<time
			datetime={entry.occurredAt}
			title={absoluteTime(entry.occurredAt)}
			class="shrink-0 text-xs whitespace-nowrap text-muted-foreground"
		>
			{relativeTime(entry.occurredAt)}
		</time>
	</div>
	<p class="text-sm">{entry.summary}</p>
	<p class="text-xs text-muted-foreground">{absoluteTime(entry.occurredAt)}</p>
</div>
