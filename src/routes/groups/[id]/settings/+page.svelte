<script lang="ts">
	// `/groups/[id]/settings` — group settings: rename (PLAN §6.4).
	//
	// Mobile-first, server-first, progressively enhanced. The rename form pre-fills
	// with the current group name and posts to the `rename` action; superForm
	// `enhance` upgrades it for inline feedback without a full navigation.
	import { resolve } from '$app/paths';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { renameGroupSchema } from '$lib/schemas/group';
	import { network } from '$lib/pwa/online.svelte';
	import { writeDisabled } from '$lib/pwa/offline-writes';
	import * as Card from '$lib/components/ui/card';
	import * as Form from '$lib/components/ui/form';
	import { Input } from '$lib/components/ui/input';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// svelte-ignore state_referenced_locally
	const renameForm = superForm(data.renameForm, {
		validators: zod4Client(renameGroupSchema)
	});
	const { form: renameData, message, submitting, enhance } = renameForm;

	const write = $derived(writeDisabled(network.offline, $submitting));
</script>

<svelte:head>
	<title>Settings · {data.group.name} · Pay with me</title>
</svelte:head>

<div class="mx-auto w-full max-w-2xl space-y-4">
	<div>
		<h1 class="text-2xl font-semibold">Settings</h1>
		<span class="text-muted-foreground text-sm">
			{data.group.name} ·
			<a
				href={resolve('/groups/[id]/transactions', { id: data.group.id })}
				class="hover:underline"
			>
				Transactions
			</a>
			·
			<a href={resolve('/groups/[id]/members', { id: data.group.id })} class="hover:underline">
				Members
			</a>
			·
			<a href={resolve('/groups/[id]/settle', { id: data.group.id })} class="hover:underline">
				Settle up
			</a>
			·
			<a href={resolve('/groups/[id]/activity', { id: data.group.id })} class="hover:underline">
				Activity
			</a>
		</span>
	</div>

	{#if $message}
		<p
			class={$message.type === 'error' ? 'text-destructive text-sm' : 'text-sm'}
			role={$message.type === 'error' ? 'alert' : 'status'}
		>
			{$message.text}
		</p>
	{/if}

	<Card.Root>
		<Card.Header>
			<Card.Title>Group name</Card.Title>
		</Card.Header>
		<Card.Content>
			<form method="POST" action="?/rename" use:enhance class="space-y-4">
				<Form.Field form={renameForm} name="name">
					<Form.Control>
						{#snippet children({ props })}
							<Form.Label>Name</Form.Label>
							<Input
								{...props}
								type="text"
								placeholder="Trip to Chiang Mai"
								bind:value={$renameData.name}
							/>
						{/snippet}
					</Form.Control>
					<Form.FieldErrors />
				</Form.Field>

				<Form.Button
					disabled={write.disabled}
					title={write.reason ?? undefined}
					aria-describedby={write.reason ? 'offline-write-note' : undefined}
				>
					{$submitting ? 'Saving…' : 'Save'}
				</Form.Button>

				{#if network.offline}
					<p id="offline-write-note" class="text-muted-foreground text-sm" role="note">
						{write.reason}
					</p>
				{/if}
			</form>
		</Card.Content>
	</Card.Root>
</div>
