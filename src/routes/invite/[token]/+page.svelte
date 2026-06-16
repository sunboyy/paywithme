<script lang="ts">
	// `/invite/[token]` accept flow UI (task 3.7; PLAN §6.2, §10 mobile-first).
	//
	// Renders one of four states from `load` (+ the action's failure result):
	//   - need_auth : anonymous visitor — show the invite context + sign-in /
	//                 create-account links carrying `?redirectTo` (or the invalid
	//                 message when the link is already dead).
	//   - ready     : logged-in + valid — an explicit Accept button that POSTs to
	//                 `?/accept` (a REAL form action, works without JS).
	//   - invalid   : dead link — clear copy + a link back to /groups.
	//   - slot_taken: targeted slot already claimed — clear copy + /groups link.
	//
	// shadcn components come from `$lib/components/ui/**` (CLI-generated) only.
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// The action's failure (`fail(...)`) carries the invalid/slot_taken state; it
	// takes precedence over the `load` state so a failed POST shows the right copy.
	const view = $derived(form?.state ?? data.state);
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
	{#if view === 'need_auth'}
		{#if data.state === 'need_auth' && data.valid}
			<Card.Header>
				<Card.Title class="text-2xl">You've been invited</Card.Title>
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
				<Card.Title class="text-2xl">Invite unavailable</Card.Title>
			</Card.Header>
			<Card.Content>
				<p class="text-muted-foreground text-sm">
					This invite is invalid, expired, or was revoked.
				</p>
			</Card.Content>
		{/if}
	{:else if view === 'ready'}
		<Card.Header>
			<Card.Title class="text-2xl">
				Join {data.state === 'ready' ? data.groupName : ''}
			</Card.Title>
			<Card.Description>Accept this invitation to join the group.</Card.Description>
		</Card.Header>
		<Card.Content>
			<!-- Real form action — works without JS; `enhance` upgrades it. -->
			<form method="POST" action="?/accept" use:enhance>
				<Button type="submit" class="w-full">Accept invitation</Button>
			</form>
		</Card.Content>
	{:else if view === 'slot_taken'}
		<Card.Header>
			<Card.Title class="text-2xl">Invitation already used</Card.Title>
		</Card.Header>
		<Card.Content class="space-y-4">
			<p class="text-muted-foreground text-sm">This invitation has already been used.</p>
			<Button href={resolve('/groups')} variant="outline" class="w-full">Go to your groups</Button>
		</Card.Content>
	{:else}
		<Card.Header>
			<Card.Title class="text-2xl">Invite unavailable</Card.Title>
		</Card.Header>
		<Card.Content class="space-y-4">
			<p class="text-muted-foreground text-sm">This invite is invalid, expired, or was revoked.</p>
			<Button href={resolve('/groups')} variant="outline" class="w-full">Go to your groups</Button>
		</Card.Content>
	{/if}
</Card.Root>
