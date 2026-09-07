<script lang="ts">
	// The one action-feedback banner.
	//
	// Every form screen surfaced its superForm `message` as a bare paragraph, each
	// with slightly different classes, and a success line was indistinguishable
	// from body text. This renders success and error as what they are — a tinted,
	// icon-led banner — and keeps the live-region semantics right: `alert` for an
	// error (interrupts), `status` for a success (polite).
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';

	let {
		message
	}: {
		// `App.Superforms.Message` — the app-wide superForm message shape. `sent`
		// (the magic-link confirmation) reads as a non-error, like `success`.
		message: App.Superforms.Message | null | undefined;
	} = $props();

	const error = $derived(message?.type === 'error');
</script>

{#if message}
	<div
		class="flex items-start gap-2 rounded-md border p-3 text-sm {error
			? 'border-destructive/40 bg-destructive/10 text-destructive'
			: 'border-border bg-muted/50 text-foreground'}"
		role={error ? 'alert' : 'status'}
	>
		{#if error}
			<CircleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		{:else}
			<CircleCheckIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		{/if}
		<p class="text-pretty">{message.text}</p>
	</div>
{/if}
