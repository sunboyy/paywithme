<script lang="ts">
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card';
	import DisplayNameForm from './display-name-form.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Finish signing in · Pay with me</title>
</svelte:head>

{#if data.error}
	<!-- Verification failed / link invalid (PLAN §12): show friendly copy + retry. -->
	<Card.Root>
		<Card.Header>
			<Card.Title class="text-2xl">Sign-in link problem</Card.Title>
		</Card.Header>
		<Card.Content>
			<p class="text-destructive text-sm" role="alert">{data.error}</p>
		</Card.Content>
		<Card.Footer>
			<p class="text-muted-foreground text-sm">
				<!-- `/register` is the resolvable retry route; `/login` arrives in task 2.7. -->
				<a
					href={resolve('/register')}
					class="text-foreground font-medium underline underline-offset-4"
				>
					Request a new sign-in link
				</a>
			</p>
		</Card.Footer>
	</Card.Root>
{:else if data.form}
	<!-- Authenticated but no display name yet (PLAN §5.3, #26): capture it. -->
	<DisplayNameForm data={data.form} />
{/if}
