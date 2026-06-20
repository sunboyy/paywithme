<script lang="ts">
	// Reusable destructive-action button + confirmation (PLAN §10 "Destructive
	// actions require explicit confirmation").
	//
	// Renders a REAL form action (works without JS — the server is the source of
	// truth). Confirmation is a progressive-enhancement layer:
	//   - BEFORE mount (SSR / no-JS / pre-hydration): a plain `<Button type="submit">`
	//     submits the form directly — no dialog, no gate.
	//   - AFTER mount (`mounted` flips in `onMount`): the same visual button becomes
	//     an AlertDialog trigger; confirming via `AlertDialog.Action` submits.
	//
	// The dialog content is PORTALED out of the form's DOM subtree, so a submit
	// button inside it isn't part of the form. We capture the `<form>` element with
	// `bind:this` and call `formEl.requestSubmit()` in the Action's `onclick` — a
	// reliable cross-portal submit that `use:enhance` still intercepts.
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';

	// A Svelte `use:` action over a form. Typed permissively in its parameter so
	// any superForm's `enhance` (whose event-param type is specific to its own
	// schema) assigns here — this component is schema-agnostic and only forwards
	// the action to `use:enhance` on the real form.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type EnhanceAction = (node: HTMLFormElement, param?: any) => { destroy?(): void } | void;

	let {
		action,
		enhance,
		hiddenName,
		hiddenValue,
		triggerLabel,
		title,
		description,
		confirmLabel,
		disabled = false
	}: {
		action: string;
		enhance: EnhanceAction;
		hiddenName: string;
		hiddenValue: string;
		triggerLabel: string;
		title: string;
		description: string;
		confirmLabel: string;
		disabled?: boolean;
	} = $props();

	// Progressive-enhancement flag: false during SSR + until hydration completes,
	// so the no-JS fallback (a plain submit button) renders first.
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	// The real form element — used to `requestSubmit()` from the portaled dialog.
	let formEl = $state<HTMLFormElement | null>(null);
</script>

<form method="POST" {action} use:enhance bind:this={formEl}>
	<input type="hidden" name={hiddenName} value={hiddenValue} />

	{#if mounted}
		<AlertDialog.Root>
			<AlertDialog.Trigger class="" disabled={disabled || undefined} aria-label={triggerLabel}>
				{#snippet child({ props })}
					<Button {...props} type="button" variant="outline" size="sm" class="min-h-11" {disabled}>
						{triggerLabel}
					</Button>
				{/snippet}
			</AlertDialog.Trigger>
			<AlertDialog.Content>
				<AlertDialog.Header>
					<AlertDialog.Title>{title}</AlertDialog.Title>
					<AlertDialog.Description>{description}</AlertDialog.Description>
				</AlertDialog.Header>
				<AlertDialog.Footer>
					<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
					<AlertDialog.Action
						variant="destructive"
						{disabled}
						onclick={() => formEl?.requestSubmit()}
					>
						{confirmLabel}
					</AlertDialog.Action>
				</AlertDialog.Footer>
			</AlertDialog.Content>
		</AlertDialog.Root>
	{:else}
		<!-- No-JS fallback: a real submit button, no confirmation gate. -->
		<Button type="submit" variant="outline" size="sm" {disabled} aria-label={triggerLabel}>
			{triggerLabel}
		</Button>
	{/if}
</form>
