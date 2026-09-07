<script lang="ts">
	// `/groups/[id]/captures/new` — the quick-capture screen (issue #50; PLAN §7.7,
	// §10).
	//
	// ONE SCREEN, ONE REQUIRED FIELD. The note is the only thing you must fill in;
	// the amount and the date are already optional and the date already says today.
	// Every control here is a real form control inside one real <form>, so the whole
	// screen works with JavaScript off — `use:enhance` only spares the page reload.
	//
	// The word "Capture" appears nowhere a user can read it: it is internal
	// vocabulary (PLAN §7.7 / CONTEXT.md), and the phrase the UI uses is "not
	// recorded yet".
	//
	// The currency picker is a NATIVE <select>, not the shadcn Select, for the same
	// reason `/groups/new` keeps one for its no-JS branch: it posts on its own with
	// no hydration, and on a phone it opens the OS picker — which is the fastest
	// control there is, on the screen whose whole value is speed.
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import FormStatus from '$lib/components/FormStatus.svelte';
	import MobileActionBar from '$lib/components/MobileActionBar.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { network } from '$lib/pwa/online.svelte';
	import { writeDisabled } from '$lib/pwa/offline-writes';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// A rejected submit re-renders what was typed; otherwise the load's defaults
	// (blank note, the group's currency, today).
	const values = $derived(form?.values ?? data.values);
	const fieldErrors = $derived(form?.fieldErrors ?? {});

	const groupPath = $derived(resolve('/groups/[id]', { id: data.group.id }));

	let submitting = $state(false);
	const write = $derived(writeDisabled(network.offline, submitting));
</script>

<svelte:head>
	<title>Not recorded yet · {data.group.name}</title>
</svelte:head>

<div class="mx-auto w-full max-w-lg space-y-6">
	<PageHeader
		title="Note it for later"
		description="Say the expense exists now and record the details later. Everyone in the group can see it until it's recorded."
		backHref={groupPath}
		backLabel={data.group.name}
	/>

	<FormStatus message={form?.message} />

	<Card.Root>
		<Card.Content>
			<form
				method="POST"
				class="space-y-5"
				use:enhance={() => {
					submitting = true;
					return async ({ update }) => {
						await update();
						submitting = false;
					};
				}}
			>
				<!-- THE one required field. Everything below it is optional, and the
				     screen is finishable from here with a single tap on Save. -->
				<div class="space-y-2">
					<Label for="note">What was it?</Label>
					<Textarea
						id="note"
						name="note"
						rows={2}
						required
						maxlength={data.noteMaxLength}
						placeholder="Dinner at the night market"
						value={values.note}
						aria-invalid={fieldErrors.note ? 'true' : undefined}
						aria-describedby={fieldErrors.note ? 'note-error' : undefined}
					/>
					{#if fieldErrors.note}
						<p id="note-error" class="text-sm text-destructive">{fieldErrors.note[0]}</p>
					{/if}
				</div>

				<!-- Optional money, entered as ONE fact: leave the amount blank and
				     nothing is stored (no rate, no conversion — §7.7 "Edge cases"). -->
				<div class="space-y-2">
					<Label for="amount">Roughly how much? <span class="font-normal">(optional)</span></Label>
					<div class="flex gap-2">
						<Input
							id="amount"
							name="amount"
							type="text"
							inputmode="decimal"
							autocomplete="off"
							placeholder="1,200"
							class="flex-1"
							value={values.amount}
							aria-invalid={fieldErrors.amount ? 'true' : undefined}
							aria-describedby={fieldErrors.amount ? 'amount-error' : undefined}
						/>
						<!-- Native select: posts without hydration, opens the OS picker on a
						     phone. Classes mirror the no-JS select on `/groups/new`. -->
						<select
							name="currency"
							aria-label="Currency"
							class="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
						>
							{#each data.currencies as currency (currency.code)}
								<!-- `displayCode`, never the opaque `cur_…` key (CONTEXT.md). -->
								<option value={currency.code} selected={currency.code === values.currency}>
									{currency.displayCode}
								</option>
							{/each}
						</select>
					</div>
					{#if fieldErrors.amount}
						<p id="amount-error" class="text-sm text-destructive">{fieldErrors.amount[0]}</p>
					{/if}
					{#if fieldErrors.currency}
						<p class="text-sm text-destructive">{fieldErrors.currency[0]}</p>
					{/if}
				</div>

				<div class="space-y-2">
					<Label for="capturedFor">When was it?</Label>
					<Input
						id="capturedFor"
						name="capturedFor"
						type="date"
						value={values.capturedFor}
						aria-invalid={fieldErrors.capturedFor ? 'true' : undefined}
						aria-describedby={fieldErrors.capturedFor ? 'capturedFor-error' : undefined}
					/>
					{#if fieldErrors.capturedFor}
						<p id="capturedFor-error" class="text-sm text-destructive">
							{fieldErrors.capturedFor[0]}
						</p>
					{/if}
				</div>

				<!-- Thumb-reachable on a phone (§10); a normal block from `sm:` up. The
				     real submit lives inside the real form, so no-JS is unaffected. -->
				<MobileActionBar class="flex flex-col gap-3 sm:flex-row-reverse">
					<Button
						type="submit"
						class="w-full sm:w-auto"
						disabled={write.disabled}
						title={write.reason ?? undefined}
						aria-describedby={write.reason ? 'offline-write-note' : undefined}
					>
						{submitting ? 'Saving…' : 'Save'}
					</Button>
					<Button variant="outline" href={groupPath} class="w-full sm:w-auto">Cancel</Button>
				</MobileActionBar>
				{#if network.offline}
					<p id="offline-write-note" class="text-sm text-muted-foreground" role="note">
						{write.reason}
					</p>
				{/if}
			</form>
		</Card.Content>
	</Card.Root>
</div>
