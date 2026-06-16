<script lang="ts">
	// `/groups/[id]/members` — manage members + soft-deactivate (task 3.5;
	// PLAN §6.1, §6.2 display-name edit, §6.3 lifecycle).
	//
	// Mobile-first, server-first, progressively enhanced: every control is a real
	// form action carrying a hidden `memberId` (like settings' delete form), so it
	// works with JS disabled; superForm `enhance` upgrades each one. Invite links
	// (create/copy/revoke) are task 3.6 and are intentionally NOT here.
	//
	// shadcn-svelte components are used from `$lib/components/ui/**` (CLI-generated;
	// never hand-authored / edited here).
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { addMemberSchema } from '$lib/schemas/member';
	import * as Card from '$lib/components/ui/card';
	import * as Form from '$lib/components/ui/form';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Separator } from '$lib/components/ui/separator';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Add-member form (its own superForm, validated client + server).
	// svelte-ignore state_referenced_locally
	const addForm = superForm(data.addForm, {
		validators: zod4Client(addMemberSchema),
		resetForm: true
	});
	const { form: addData, message: addMessage, submitting: adding, enhance: addEnhance } = addForm;

	// Rename / remove / reactivate share one superForm each so their action
	// `message` surfaces once. The per-row hidden `memberId` selects the target.
	// svelte-ignore state_referenced_locally
	const renameForm = superForm(data.renameForm);
	const { message: renameMessage, enhance: renameEnhance } = renameForm;

	// svelte-ignore state_referenced_locally
	const removeForm = superForm(data.removeForm);
	const { message: removeMessage, enhance: removeEnhance, submitting: removing } = removeForm;

	// svelte-ignore state_referenced_locally
	const reactivateForm = superForm(data.reactivateForm);
	const {
		message: reactivateMessage,
		enhance: reactivateEnhance,
		submitting: reactivating
	} = reactivateForm;

	// Surface the most recent action status across the row forms (one banner).
	const statusMessage = $derived(
		$removeMessage ?? $reactivateMessage ?? $renameMessage ?? $addMessage ?? null
	);
</script>

<svelte:head>
	<title>Members · {data.group.name} · Pay with me</title>
</svelte:head>

<div class="space-y-6">
	<div class="space-y-1">
		<h1 class="text-2xl font-semibold tracking-tight">{data.group.name}</h1>
		<p class="text-muted-foreground text-sm">Manage who's splitting in this group.</p>
	</div>

	{#if statusMessage}
		<p
			class={statusMessage.type === 'error' ? 'text-destructive text-sm' : 'text-sm'}
			role={statusMessage.type === 'error' ? 'alert' : 'status'}
		>
			{statusMessage.text}
		</p>
	{/if}

	<Card.Root>
		<Card.Header>
			<Card.Title>Members</Card.Title>
			<Card.Description>
				Add a participant for anyone splitting costs — they don't need an account. Inactive members
				stay in past transactions.
			</Card.Description>
		</Card.Header>

		<Card.Content class="space-y-4">
			{#if data.members.length === 0}
				<p class="text-muted-foreground text-sm">No members yet — add the first one below.</p>
			{:else}
				<ul class="divide-border divide-y" aria-label="Group members">
					{#each data.members as member (member.id)}
						{@const isYou = member.isLinked && member.userId === data.viewerUserId}
						{@const isInactive = member.deactivatedAt != null}
						<li class="space-y-3 py-3">
							<div class="flex flex-wrap items-center gap-2">
								<span class="font-medium {isInactive ? 'text-muted-foreground' : ''}">
									{member.displayName}
								</span>
								{#if isYou}
									<Badge variant="secondary">You</Badge>
								{:else if member.isLinked}
									<Badge variant="outline">Linked</Badge>
								{/if}
								{#if isInactive}
									<Badge variant="outline" class="text-muted-foreground">Inactive</Badge>
								{/if}
							</div>

							<!-- Rename (works without JS): a real form, name pre-filled. -->
							<form
								method="POST"
								action="?/renameMember"
								use:renameEnhance
								class="flex flex-col gap-2 sm:flex-row sm:items-center"
							>
								<input type="hidden" name="memberId" value={member.id} />
								<Input
									type="text"
									name="displayName"
									value={member.displayName}
									aria-label="Display name for {member.displayName}"
									maxlength={100}
									class="sm:max-w-xs"
								/>
								<Button type="submit" variant="outline" size="sm">Rename</Button>
							</form>

							<div class="flex flex-wrap gap-2">
								{#if isInactive}
									<!-- Reactivate (flag flip, §6.3). -->
									<form method="POST" action="?/reactivate" use:reactivateEnhance>
										<input type="hidden" name="memberId" value={member.id} />
										<Button type="submit" variant="outline" size="sm" disabled={$reactivating}>
											Reactivate
										</Button>
									</form>
								{:else}
									<!-- Remove: soft-deactivate if they have activity, else hard-delete (§6.3). -->
									<form method="POST" action="?/removeMember" use:removeEnhance>
										<input type="hidden" name="memberId" value={member.id} />
										<Button
											type="submit"
											variant="outline"
											size="sm"
											disabled={$removing}
											aria-label="Remove {member.displayName}"
										>
											Remove
										</Button>
									</form>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/if}

			<Separator />

			<!-- Add a new unlinked member (a participant slot, §6.1). -->
			<form method="POST" action="?/addMember" use:addEnhance class="space-y-3">
				<Form.Field form={addForm} name="displayName">
					<Form.Control>
						{#snippet children({ props })}
							<Form.Label>Add a member</Form.Label>
							<div class="flex flex-col gap-2 sm:flex-row sm:items-start">
								<Input
									{...props}
									type="text"
									placeholder="e.g. Alex"
									bind:value={$addData.displayName}
									class="sm:max-w-xs"
								/>
								<Button type="submit" disabled={$adding}>
									{$adding ? 'Adding…' : 'Add member'}
								</Button>
							</div>
						{/snippet}
					</Form.Control>
					<Form.FieldErrors />
				</Form.Field>
			</form>
		</Card.Content>
	</Card.Root>
</div>
