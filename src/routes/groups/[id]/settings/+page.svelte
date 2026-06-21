<script lang="ts">
	// `/groups/[id]/settings` — group settings: rename (PLAN §6.4).
	//
	// Mobile-first, server-first, progressively enhanced. The rename form pre-fills
	// with the current group name and posts to the `rename` action; superForm
	// `enhance` upgrades it for inline feedback without a full navigation.
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { renameGroupSchema } from '$lib/schemas/group';
	import { network } from '$lib/pwa/online.svelte';
	import { writeDisabled } from '$lib/pwa/offline-writes';
	import * as Card from '$lib/components/ui/card';
	import * as Form from '$lib/components/ui/form';
	import { Input } from '$lib/components/ui/input';
	import GroupNav from '$lib/components/GroupNav.svelte';
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
	<header class="space-y-3">
		<h1 class="truncate text-2xl font-semibold tracking-tight">{data.group.name}</h1>
		<GroupNav groupId={data.group.id} current="settings" />
	</header>

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
