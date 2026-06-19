<script lang="ts">
	import * as Card from '$lib/components/ui/card';

	// Static landing placeholder that sits inside the app shell.
	// The "redirect to dashboard if logged in" behaviour (PLAN §10) needs a
	// session and is intentionally deferred to Phase 2.
</script>

<svelte:head>
	<title>Pay with me</title>
</svelte:head>

<Card.Root>
	<Card.Header>
		<Card.Title role="heading" aria-level={1} class="text-2xl">Pay with me</Card.Title>
		<Card.Description>Split group spending and settle up, the easy way.</Card.Description>
	</Card.Header>
</Card.Root>
