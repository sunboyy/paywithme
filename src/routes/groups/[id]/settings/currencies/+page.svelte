<script lang="ts">
	// `/groups/[id]/settings/currencies` — define and edit a group's CUSTOM
	// currencies (issue #62; PLAN §7.5.2, §10; ADR-0014).
	//
	// Mobile-first, server-first, progressively enhanced: create / edit / delete are
	// all real form actions (they work with JS disabled), superForm `enhance`
	// upgrades each one, and the only JS-only part is the live preview.
	//
	// ── The one thing this screen has to get right ───────────────────────────────
	// A user asking for a custom currency has most likely assumed it will be what
	// their balances are shown in. It never is (ADR-0014 decision 1) — a custom
	// currency is an ENTRY currency, and the group still settles in its settlement
	// currency. Finding that out after recording ten transactions is the bad
	// outcome, so the notice sits above BOTH the list and the add form, in prose,
	// naming the actual settlement currency.
	//
	// shadcn-svelte components come from `$lib/components/ui/**` (CLI-generated;
	// never hand-authored here).
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { resolve } from '$app/paths';
	import { createCustomCurrencySchema } from '$lib/schemas/custom-currency';
	import { network } from '$lib/pwa/online.svelte';
	import { writeDisabled } from '$lib/pwa/offline-writes';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import GroupNav from '$lib/components/GroupNav.svelte';
	import CustomCurrencyFields from '$lib/components/CustomCurrencyFields.svelte';
	import CustomCurrencyRow from '$lib/components/CustomCurrencyRow.svelte';
	import CoinsIcon from '@lucide/svelte/icons/coins';
	import InfoIcon from '@lucide/svelte/icons/info';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Add a currency. Its own superForm (validated client + server); reset on
	// success so the form is ready for the next one.
	// svelte-ignore state_referenced_locally
	const createForm = superForm(data.createForm, {
		validators: zod4Client(createCustomCurrencySchema),
		resetForm: true
	});
	const {
		form: createData,
		errors: createErrors,
		message: createMessage,
		submitting: creating,
		enhance: createEnhance
	} = createForm;

	// Edit. ONE superForm shared by every row (each row's hidden `code` names the
	// target); `resetForm: false` because rows hold their own field state.
	// svelte-ignore state_referenced_locally
	const editForm = superForm(data.editForm, { resetForm: false });
	const {
		form: editData,
		errors: editErrors,
		message: editMessage,
		submitting: saving,
		enhance: editEnhance
	} = editForm;

	// Delete (per-row hidden `code`, behind a confirmation — PLAN §10).
	// svelte-ignore state_referenced_locally
	const deleteForm = superForm(data.deleteForm);
	const { message: deleteMessage, submitting: deleting, enhance: deleteEnhance } = deleteForm;

	// One status banner for the three forms.
	const statusMessage = $derived($deleteMessage ?? $editMessage ?? $createMessage ?? null);

	// Which row the last edit submit was for — errors belong to THAT row only, or a
	// duplicate-code message would light up every row's Code field at once.
	const editTarget = $derived($editData.code);

	const write = $derived(writeDisabled(network.offline, $creating));
	const rowWrite = $derived(writeDisabled(network.offline));

	const settingsHref = $derived(resolve('/groups/[id]/settings', { id: data.group.id }));
</script>

<svelte:head>
	<title>Currencies · {data.group.name} · Pay with me</title>
</svelte:head>

<div class="mx-auto w-full max-w-2xl space-y-4">
	<header class="space-y-3">
		<h1 class="truncate text-2xl font-semibold tracking-tight">{data.group.name}</h1>
		<GroupNav groupId={data.group.id} current="settings" />
	</header>

	<a
		href={settingsHref}
		class="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
	>
		<ChevronLeftIcon class="size-4" aria-hidden="true" />
		Back to settings
	</a>

	{#if statusMessage}
		<p
			class={statusMessage.type === 'error' ? 'text-sm text-destructive' : 'text-sm'}
			role={statusMessage.type === 'error' ? 'alert' : 'status'}
		>
			{statusMessage.text}
		</p>
	{/if}

	<!-- THE LIMIT, said out loud (ADR-0014 "Consequences"). Above the list and the
	     add form, so it is read before a currency is defined, not after. -->
	<div
		class="flex gap-3 rounded-md border border-border bg-muted/50 p-4 text-sm"
		role="note"
		data-testid="settlement-currency-notice"
	>
		<InfoIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		<p class="text-pretty">
			Balances are always shown in <strong>{data.settlement.displayCode}</strong>
			({data.settlement.name}). A custom currency is for recording a transaction — the group still
			settles in {data.settlement.displayCode}.
		</p>
	</div>

	<Card.Root>
		<Card.Header>
			<Card.Title>Custom currencies</Card.Title>
			<Card.Description>
				Units this group defined itself — an unlisted national currency, or something that was never
				money. They can be used when recording a transaction, alongside the built-in currencies.
			</Card.Description>
		</Card.Header>

		<Card.Content class="space-y-4">
			{#if data.currencies.length === 0}
				<!-- Nothing-yet nudge (the add form below is the CTA, so this stays
				     inline rather than becoming a nested card). -->
				<div
					class="flex flex-col items-center gap-3 py-6 text-center text-muted-foreground"
					data-testid="currencies-empty"
				>
					<span
						class="flex size-12 items-center justify-center rounded-full bg-muted"
						aria-hidden="true"
					>
						<CoinsIcon class="size-6" />
					</span>
					<div class="space-y-1">
						<p class="text-base font-medium text-foreground">No custom currencies yet</p>
						<p class="mx-auto max-w-prose text-sm text-pretty">
							This group uses the built-in currencies. Add your own below if you need one they don't
							cover.
						</p>
					</div>
				</div>
			{:else}
				<ul class="divide-y divide-border" aria-label="Custom currencies">
					{#each data.currencies as currency (currency.code)}
						<CustomCurrencyRow
							{currency}
							{editEnhance}
							{deleteEnhance}
							errors={editTarget === currency.code ? $editErrors : {}}
							saving={$saving}
							deleting={$deleting}
							disabled={rowWrite.disabled}
							disabledReason={rowWrite.reason}
						/>
					{/each}
				</ul>
			{/if}

			<Separator />

			<!-- Add a currency (a REAL form action; works without JS). -->
			<form method="POST" action="?/create" use:createEnhance class="space-y-4">
				<h2 class="text-base font-medium">Add a currency</h2>

				<CustomCurrencyFields
					idPrefix="create"
					bind:displayCode={$createData.displayCode}
					bind:currencyName={$createData.name}
					bind:symbol={$createData.symbol}
					bind:exponent={$createData.exponent}
					errors={$createErrors}
				/>

				<Button
					type="submit"
					disabled={write.disabled}
					title={write.reason ?? undefined}
					aria-describedby={write.reason ? 'offline-write-note' : undefined}
				>
					{$creating ? 'Adding…' : 'Add currency'}
				</Button>

				{#if network.offline}
					<p id="offline-write-note" class="text-sm text-muted-foreground" role="note">
						{write.reason}
					</p>
				{/if}
			</form>
		</Card.Content>
	</Card.Root>
</div>
