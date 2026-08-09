<script lang="ts">
	// One row of the manage-custom-currencies screen: the summary line, the edit
	// form behind a disclosure, and the delete control (issue #62; PLAN §7.5.2, §10).
	//
	// It exists as its OWN component for one reason: each row's fields need their
	// own local state so the live preview can update as that row is typed into, and
	// `{#each}` can't declare state per iteration. It owns nothing else — the forms
	// are the page's real form actions, forwarded in via `use:` enhancers, so every
	// control still works with JS disabled.
	//
	// `<details>` rather than a JS popover, matching the members roster: a group with
	// three custom currencies is otherwise three permanently-open forms, and the
	// disclosure keeps edit reachable without JS.
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
	import CustomCurrencyFields from '$lib/components/CustomCurrencyFields.svelte';

	// A Svelte `use:` action over a form — permissive in its parameter so any
	// superForm's schema-specific `enhance` assigns here (same shape as
	// `ConfirmSubmit`, which is likewise schema-agnostic).
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type EnhanceAction = (node: HTMLFormElement, param?: any) => { destroy?(): void } | void;

	let {
		currency,
		editEnhance,
		deleteEnhance,
		errors = {},
		saving = false,
		deleting = false,
		disabled = false,
		disabledReason = null
	}: {
		/** The stored row as `load` returned it. `code` is opaque and never displayed. */
		currency: {
			code: string;
			displayCode: string;
			name: string;
			symbol: string;
			exponent: number;
			isReferenced: boolean;
		};
		editEnhance: EnhanceAction;
		deleteEnhance: EnhanceAction;
		/** Per-field errors from the last edit submit — only ever this row's. */
		errors?: Partial<Record<'displayCode' | 'name' | 'symbol' | 'exponent', string[] | undefined>>;
		saving?: boolean;
		deleting?: boolean;
		/** Writes blocked (offline / in flight), with the reason to announce. */
		disabled?: boolean;
		disabledReason?: string | null;
	} = $props();

	// Row-local field state, seeded from the stored row. Not derived: the point is
	// that the user can type into it and watch the preview change. After a
	// successful save `load` re-runs and the stored row already matches what was
	// typed, so there is nothing to re-sync.
	// svelte-ignore state_referenced_locally
	let displayCode = $state(currency.displayCode);
	// svelte-ignore state_referenced_locally
	let currencyName = $state(currency.name);
	// svelte-ignore state_referenced_locally
	let symbol = $state(currency.symbol);
	// svelte-ignore state_referenced_locally
	let exponent = $state(currency.exponent);

	const fieldId = $derived(`edit-${currency.code}`);
</script>

<li class="py-1">
	<details class="group/currency">
		<summary
			class="flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-md px-1 py-2 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden"
		>
			<span
				class="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground"
				aria-hidden="true"
			>
				{currency.symbol}
			</span>
			<span class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
				<span class="font-medium">{currency.displayCode}</span>
				<span class="min-w-0 truncate text-sm text-muted-foreground">{currency.name}</span>
				{#if currency.isReferenced}
					<Badge variant="secondary">In use</Badge>
				{:else}
					<Badge variant="outline" class="text-muted-foreground">Unused</Badge>
				{/if}
			</span>
			<span class="sr-only">Edit {currency.displayCode}</span>
			<ChevronDownIcon
				class="size-4 shrink-0 text-muted-foreground transition-transform group-open/currency:rotate-180"
				aria-hidden="true"
			/>
		</summary>

		<div class="space-y-4 px-1 pt-2 pb-4">
			<!-- Edit: a REAL form action carrying the opaque code as a hidden field. -->
			<form method="POST" action="?/edit" use:editEnhance class="space-y-4">
				<input type="hidden" name="code" value={currency.code} />

				<CustomCurrencyFields
					idPrefix={fieldId}
					bind:displayCode
					bind:currencyName
					bind:symbol
					bind:exponent
					locked={currency.isReferenced}
					{errors}
				/>

				<Button
					type="submit"
					variant="outline"
					size="sm"
					class="min-h-11"
					disabled={disabled || saving}
					title={disabledReason ?? undefined}
				>
					{saving ? 'Saving…' : 'Save changes'}
				</Button>
			</form>

			{#if currency.isReferenced}
				<!-- Delete is offered ONLY while unreferenced (PLAN §7.5.2). Say why not
				     rather than showing a button that always fails. -->
				<p class="text-sm text-muted-foreground" data-testid="{fieldId}-delete-blocked">
					{currency.displayCode} can't be deleted — at least one transaction is recorded in it. Deleting
					it would leave those amounts with no currency to read them by.
				</p>
			{:else}
				<ConfirmSubmit
					action="?/delete"
					enhance={deleteEnhance}
					hiddenName="code"
					hiddenValue={currency.code}
					triggerLabel="Delete {currency.displayCode}"
					title="Delete {currency.displayCode}?"
					description="{currency.displayCode} ({currency.name}) will be removed from this group. No transaction uses it, so nothing else changes."
					confirmLabel="Delete"
					disabled={disabled || deleting}
				/>
			{/if}
		</div>
	</details>
</li>
