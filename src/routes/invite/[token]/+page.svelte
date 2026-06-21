<script lang="ts">
	// `/invite/[token]` accept flow UI (task 3.7; PLAN §6.2, §10 mobile-first).
	//
	// Renders one of three states from `load`:
	//   - need_auth : anonymous visitor — show the invite context + sign-in /
	//                 create-account links carrying `?redirectTo` (or the invalid
	//                 message when the link is already dead).
	//   - ready     : logged-in + valid — the member-agnostic CHOICE form
	//                 (`AcceptChoiceForm`): join as a NEW member, or LINK an
	//                 existing unlinked slot.
	//   - invalid   : dead link — clear copy + a link back to /groups.
	//
	// shadcn components (Card/Button) come from `$lib/components/ui/**`
	// (CLI-generated) only.
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import AcceptChoiceForm from './AcceptChoiceForm.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const registerHref = $derived(
		data.state === 'need_auth' && data.redirectTo
			? '/register?redirectTo=' + encodeURIComponent(data.redirectTo)
			: resolve('/register')
	);
	const loginHref = $derived(
		data.state === 'need_auth' && data.redirectTo
			? '/login?redirectTo=' + encodeURIComponent(data.redirectTo)
			: resolve('/login')
	);
</script>

<svelte:head>
	<title>Join a group · Pay with me</title>
</svelte:head>

<Card.Root>
	{#if data.state === 'need_auth'}
		{#if data.valid}
			<Card.Header>
				<Card.Title role="heading" aria-level={1} class="text-2xl">You've been invited</Card.Title>
				<Card.Description>
					You've been invited to join <strong>{data.groupName}</strong>. Sign in to accept.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-3">
				<!-- `loginHref`/`registerHref` carry a server-sanitized local `redirectTo`;
				     dynamic, so not statically `resolve()`able. -->
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
				<Button href={loginHref} class="w-full">Sign in to accept</Button>
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
				<Button href={registerHref} variant="outline" class="w-full">Create an account</Button>
			</Card.Content>
		{:else}
			<Card.Header>
				<Card.Title role="heading" aria-level={1} class="text-2xl">Invite unavailable</Card.Title>
			</Card.Header>
			<Card.Content>
				<p class="text-muted-foreground text-sm">
					This invite link is no longer available.
				</p>
			</Card.Content>
		{/if}
	{:else if data.state === 'ready'}
		<Card.Header>
			<Card.Title role="heading" aria-level={1} class="text-2xl">Join {data.groupName}</Card.Title>
			<Card.Description>Choose how you'd like to join this group.</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			<AcceptChoiceForm
				groupName={data.groupName}
				userName={data.userName}
				claimableMembers={data.claimableMembers}
				acceptForm={data.acceptForm}
			/>
		</Card.Content>
	{:else}
		<Card.Header>
			<Card.Title role="heading" aria-level={1} class="text-2xl">Invite unavailable</Card.Title>
		</Card.Header>
		<Card.Content class="space-y-4">
			<p class="text-muted-foreground text-sm">This invite link is no longer available.</p>
			<Button href={resolve('/groups')} variant="outline" class="w-full">Go to your groups</Button>
		</Card.Content>
	{/if}
</Card.Root>
