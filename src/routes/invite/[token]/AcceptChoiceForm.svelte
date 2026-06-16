<script lang="ts">
	// The logged-in + valid accept CHOICE form (PLAN §6.2 step 3 — member-agnostic
	// accept). Split into its own component so its superForm receives a non-null
	// `acceptForm` (cleaner typing than a conditional store in the page).
	//
	// PROGRESSIVE ENHANCEMENT: plain radio inputs + a native `<select>` so it
	// submits correctly with JS disabled (mobile-first). shadcn `Button` comes
	// from `$lib/components/ui/**` (CLI-generated) only.
	import { superForm, type SuperValidated } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { acceptInviteSchema, type AcceptInviteInput } from '$lib/schemas/invite';
	import { Button } from '$lib/components/ui/button';

	let {
		groupName,
		userName,
		claimableMembers,
		acceptForm
	}: {
		groupName: string;
		userName: string;
		claimableMembers: { id: string; displayName: string }[];
		acceptForm: SuperValidated<AcceptInviteInput>;
	} = $props();

	// svelte-ignore state_referenced_locally
	const form = superForm(acceptForm, { validators: zod4Client(acceptInviteSchema) });
	const { form: formData, message, enhance, submitting } = form;
</script>

{#if $message}
	<p class="text-destructive text-sm" role="alert">{$message.text}</p>
{/if}

<!-- Real form action — works without JS; `enhance` upgrades it. -->
<form method="POST" action="?/accept" use:enhance class="space-y-4">
	<fieldset class="space-y-3">
		<legend class="text-sm font-medium">How do you want to join {groupName}?</legend>

		<!-- Join as a new member (default). -->
		<label class="flex items-start gap-3">
			<input type="radio" name="mode" value="new" bind:group={$formData.mode} class="mt-1" />
			<span class="text-sm">
				Join as a new member
				<span class="text-muted-foreground block text-xs">(as {userName})</span>
			</span>
		</label>

		{#if claimableMembers.length > 0}
			<!-- Link to an existing unlinked member slot. -->
			<label class="flex items-start gap-3">
				<input type="radio" name="mode" value="existing" bind:group={$formData.mode} class="mt-1" />
				<span class="text-sm">Link to an existing member</span>
			</label>

			<div class="pl-6">
				<label class="text-sm font-medium" for="member-select">Existing member</label>
				<select
					id="member-select"
					name="memberId"
					bind:value={$formData.memberId}
					class="border-input bg-background mt-1 block w-full rounded-md border px-3 py-2 text-sm"
				>
					<option value="" disabled selected>Select a member…</option>
					{#each claimableMembers as member (member.id)}
						<option value={member.id}>{member.displayName}</option>
					{/each}
				</select>
			</div>
		{/if}
	</fieldset>

	<Button type="submit" class="w-full" disabled={$submitting}>
		{$submitting ? 'Joining…' : 'Join group'}
	</Button>
</form>
