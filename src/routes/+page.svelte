<script lang="ts">
	// Anonymous landing page. Authenticated visitors never reach it — `+page.server.ts`
	// redirects them to /groups.
	//
	// This was a placeholder card that repeated the app name already in the header
	// and offered NO call to action: the only way in was the small "Sign in" link in
	// the corner, so the page was a dead end for anyone arriving cold. It is still
	// deliberately small — not a marketing site — but it now converts.
	import { resolve } from '$app/paths';
	import { buttonVariants } from '$lib/components/ui/button';
	import SplitIcon from '@lucide/svelte/icons/split';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import UsersIcon from '@lucide/svelte/icons/users';

	const points = [
		{
			icon: SplitIcon,
			title: 'Split it any way',
			body: 'Evenly, by exact amounts, by shares — or item by item with service charges and discounts.'
		},
		{
			icon: GlobeIcon,
			title: 'Any currency',
			body: 'Spend in one currency, settle in another. Balances always land in the currency your group picked.'
		},
		{
			icon: UsersIcon,
			title: 'No account needed to join',
			body: 'Add anyone as a participant right away. They can claim their spot later, or never — the maths works either way.'
		}
	];
</script>

<svelte:head>
	<title>Pay with me — split group spending and settle up</title>
	<meta
		name="description"
		content="Track shared spending with friends, split it any way, and settle up with the fewest transfers."
	/>
</svelte:head>

<div class="space-y-10 py-4">
	<section class="space-y-4">
		<h1 class="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
			Split group spending and settle up, the easy way.
		</h1>
		<p class="text-muted-foreground text-base text-pretty">
			Track what everyone paid on a trip, a flat, or a dinner. Pay with me works out who owes whom
			and squares it up in the fewest transfers.
		</p>
		<div class="flex flex-wrap items-center gap-3">
			<a href={resolve('/register')} class={buttonVariants({ size: 'lg' })}>Create an account</a>
			<a href={resolve('/login')} class={buttonVariants({ variant: 'ghost', size: 'lg' })}>
				Sign in
			</a>
		</div>
	</section>

	<section class="space-y-5">
		<h2 class="sr-only">What you can do</h2>
		{#each points as point (point.title)}
			{@const Icon = point.icon}
			<div class="flex gap-3">
				<span class="text-primary mt-0.5 shrink-0" aria-hidden="true">
					<Icon class="size-5" />
				</span>
				<div class="space-y-0.5">
					<h3 class="text-sm font-medium">{point.title}</h3>
					<p class="text-muted-foreground text-sm text-pretty">{point.body}</p>
				</div>
			</div>
		{/each}
	</section>
</div>
