<script lang="ts">
	// `/settings/receiving` — the owner's receiving-method editor (issue #85;
	// PLAN §17.1–§17.2, §17.4, §10).
	//
	// SERVER-FIRST AND FULLY PROGRESSIVE. Every control is a real form or link:
	// picking a rail is a link, add/edit/delete/reorder are form actions, and the
	// whole screen works with JavaScript disabled. `use:enhance` only avoids the
	// full page reload; the delete confirmation is the same layer (`ConfirmSubmit`
	// falls back to a plain submit button before hydration).
	//
	// REORDER IS MOVE-UP / MOVE-DOWN, not drag-and-drop: dragging cannot work
	// without JS, is miserable on a phone, and the only ordering semantics that
	// matter is "first is preferred" (PLAN §17.1) — which the "Preferred" badge on
	// row one states outright.
	//
	// NOTHING HERE KNOWS A RAIL. The picker walks `data.rails`, the form walks the
	// chosen rail's descriptors (`ReceivingMethodFields`), and the row line is the
	// rail's own formatted output computed on the server. Adding a country later is
	// a registry entry (ADR-0016) — this file is not touched.
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import ReceivingMethodFields from '$lib/components/ReceivingMethodFields.svelte';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import WalletIcon from '@lucide/svelte/icons/wallet';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const listHref = resolve('/settings/receiving');
	const addHref = (railId: string) => `${listHref}?add=${encodeURIComponent(railId)}`;
	const editHref = (methodId: string) => `${listHref}?edit=${encodeURIComponent(methodId)}`;

	const editing = $derived(data.editing);

	// A rejected submit re-renders the SAME step (the action URLs keep the query
	// param), so what the user typed wins over the stored/blank values.
	const values = $derived({ ...(editing?.values ?? {}), ...(form?.values ?? {}) });
	const fieldErrors = $derived(form?.fieldErrors ?? {});

	// `?/add&add=…` / `?/edit&edit=…`: SvelteKit reads the action from the param
	// whose key starts with `/`, so the step's own param rides along and survives a
	// validation failure. Without it the browser would land on the bare route and
	// the half-filled form would vanish.
	const editorAction = $derived(
		editing?.methodId
			? `?/edit&edit=${encodeURIComponent(editing.methodId)}`
			: `?/add&add=${encodeURIComponent(editing?.rail.id ?? '')}`
	);
</script>

<svelte:head>
	<title>How you get paid · Pay with me</title>
</svelte:head>

<div class="mx-auto w-full max-w-2xl space-y-6">
	<div class="space-y-1">
		<h1 class="text-2xl font-semibold tracking-tight">How you get paid</h1>
		<p class="text-sm text-muted-foreground">
			Where people should send money when they settle up with you. Only people you share a group
			with can see these.
		</p>
	</div>

	{#if form?.message}
		<p
			class={form.message.type === 'error' ? 'text-sm text-destructive' : 'text-sm'}
			role={form.message.type === 'error' ? 'alert' : 'status'}
		>
			{form.message.text}
		</p>
	{/if}

	{#if editing}
		<!-- Step two: the chosen rail's own fields. One rail at a time, so two rails
		     that share a field name can never collide in the submission. -->
		<Card.Root>
			<Card.Header>
				<Card.Title>{editing.methodId ? 'Edit' : 'Add'} — {editing.rail.label}</Card.Title>
				<Card.Description>
					{editing.methodId
						? 'Change the details people use to pay you.'
						: 'Fill in the details people will use to pay you.'}
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<form method="POST" action={editorAction} use:enhance class="space-y-5">
					{#if editing.methodId}
						<input type="hidden" name="id" value={editing.methodId} />
					{:else}
						<input type="hidden" name="rail" value={editing.rail.id} />
					{/if}

					<ReceivingMethodFields
						idPrefix="receiving-method"
						fields={editing.rail.fields}
						{values}
						errors={fieldErrors}
					/>

					<div class="flex flex-col gap-3 sm:flex-row-reverse">
						<Button type="submit" class="w-full sm:w-auto">Save</Button>
						<Button variant="outline" href={listHref} class="w-full sm:w-auto">Cancel</Button>
					</div>
				</form>
			</Card.Content>
		</Card.Root>
	{:else}
		<Card.Root>
			<Card.Header>
				<Card.Title>Your receiving methods</Card.Title>
				<Card.Description>
					The first one is what people see when they settle up with you. The rest sit behind “other
					ways to pay”.
				</Card.Description>
			</Card.Header>

			<Card.Content class="space-y-4">
				{#if data.methods.length === 0}
					<!-- The one-line explanation a user who has never settled up needs
					     (PLAN §17.4): this screen has no context on its own. -->
					<EmptyState
						title="No receiving methods yet"
						description="Add how you want to be paid, and anyone settling up with you in a group will see it — instead of asking you in the chat."
						icon={WalletIcon}
					/>
				{:else}
					<ul class="divide-y divide-border" aria-label="Your receiving methods">
						{#each data.methods as method (method.id)}
							<li
								class="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
								data-testid="receiving-method-row"
							>
								<div class="min-w-0 space-y-1">
									<div class="flex flex-wrap items-center gap-2">
										<p class="font-medium">{method.railLabel}</p>
										{#if method.isFirst}
											<!-- Order IS the preference (PLAN §17.1) — say so, rather than
											     leaving the user to infer it from the list order. -->
											<Badge variant="secondary">Preferred</Badge>
										{/if}
									</div>
									{#if method.summary}
										<p class="text-sm break-words text-muted-foreground">{method.summary}</p>
									{:else}
										<!-- The rail refused to render it (see `MethodView.summary`). Say
										     what to do instead of showing half an account number. -->
										<p class="text-sm text-destructive">
											These details can no longer be shown. Edit or remove this method.
										</p>
									{/if}
								</div>

								<!-- `shrink-0`: an account holder name is a third-party string that can
							     be long (a Thai name runs unbroken), and without this flexbox
							     shrinks the actions instead, wrapping Remove onto its own line.
							     The text column carries `min-w-0`, so it absorbs the squeeze. -->
								<div
									class="flex shrink-0 flex-wrap items-center gap-2"
									data-testid="receiving-method-actions"
								>
									<form method="POST" action="?/move" use:enhance>
										<input type="hidden" name="id" value={method.id} />
										<input type="hidden" name="direction" value="up" />
										<Button
											type="submit"
											variant="outline"
											size="icon"
											class="size-11 md:size-9"
											disabled={method.isFirst}
											aria-label="Move {method.railLabel} up"
										>
											<ArrowUpIcon class="size-4" aria-hidden="true" />
										</Button>
									</form>
									<form method="POST" action="?/move" use:enhance>
										<input type="hidden" name="id" value={method.id} />
										<input type="hidden" name="direction" value="down" />
										<Button
											type="submit"
											variant="outline"
											size="icon"
											class="size-11 md:size-9"
											disabled={method.isLast}
											aria-label="Move {method.railLabel} down"
										>
											<ArrowDownIcon class="size-4" aria-hidden="true" />
										</Button>
									</form>

									<Button variant="outline" size="sm" class="min-h-11" href={editHref(method.id)}>
										Edit
									</Button>

									<ConfirmSubmit
										action="?/delete"
										{enhance}
										hiddenName="id"
										hiddenValue={method.id}
										triggerLabel="Remove"
										title="Remove this {method.railLabel}?"
										description="{method.summary ??
											'These details'} — people settling up with you won't see it any more. You can add it again later."
										confirmLabel="Remove method"
									/>
								</div>
							</li>
						{/each}
					</ul>
				{/if}

				<Separator />

				<!-- Step one: pick a rail. Real links, so this works with JS disabled and
				     needs no client state; the list is the registry's own order and no
				     option is pre-selected (PLAN §17.2: no rail is privileged). -->
				<div class="space-y-2">
					<p class="text-sm font-medium">
						{data.methods.length === 0 ? 'Add a receiving method' : 'Add another'}
					</p>
					<div class="grid gap-2 sm:grid-cols-3">
						{#each data.rails as rail (rail.id)}
							<Button variant="outline" class="w-full" href={addHref(rail.id)}>{rail.label}</Button>
						{/each}
					</div>
				</div>
			</Card.Content>
		</Card.Root>

		<Button variant="ghost" href={resolve('/settings')} class="w-full sm:w-auto">
			Back to settings
		</Button>
	{/if}
</div>
