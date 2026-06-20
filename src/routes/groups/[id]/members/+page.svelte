<script lang="ts">
	// `/groups/[id]/members` — manage members + soft-deactivate (task 3.5;
	// PLAN §6.1, §6.2 display-name edit, §6.3 lifecycle).
	//
	// Mobile-first, server-first, progressively enhanced: every control is a real
	// form action carrying a hidden id (like settings' delete form), so it works
	// with JS disabled; superForm `enhance` upgrades each one. Task 3.6 adds the
	// "Invite links" section below (create/revoke are real actions; Copy is a JS
	// nicety with the link text as the no-JS fallback). The accept flow
	// (`/invite/[token]`) is task 3.7 and is not here.
	//
	// shadcn-svelte components are used from `$lib/components/ui/**` (CLI-generated;
	// never hand-authored / edited here).
	import { resolve } from '$app/paths';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { toast } from 'svelte-sonner';
	import { addMemberSchema } from '$lib/schemas/member';
	import { createInviteSchema } from '$lib/schemas/invite';
	import { network } from '$lib/pwa/online.svelte';
	import { OFFLINE_WRITE_MESSAGE } from '$lib/pwa/offline-writes';
	import * as Card from '$lib/components/ui/card';
	import * as Form from '$lib/components/ui/form';
	import { Badge } from '$lib/components/ui/badge';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Separator } from '$lib/components/ui/separator';
	import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
	import UsersIcon from '@lucide/svelte/icons/users';
	import LinkIcon from '@lucide/svelte/icons/link';
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

	// --- Invite links (PLAN §6.2) -----------------------------------------
	// Create a MEMBER-AGNOSTIC invite link (no target — the invitee chooses on
	// accept). Its own superForm so its message surfaces on its own control.
	// svelte-ignore state_referenced_locally
	const createInviteForm = superForm(data.createInviteForm, {
		validators: zod4Client(createInviteSchema),
		resetForm: true
	});
	const {
		message: createInviteMessage,
		submitting: creatingInvite,
		enhance: createInviteEnhance
	} = createInviteForm;

	// Revoke invite (per-row hidden `inviteId`).
	// svelte-ignore state_referenced_locally
	const revokeInviteForm = superForm(data.revokeInviteForm);
	const {
		message: revokeInviteMessage,
		enhance: revokeInviteEnhance,
		submitting: revoking
	} = revokeInviteForm;

	// Surface the most recent action status across the row forms (one banner).
	const statusMessage = $derived(
		$revokeInviteMessage ??
			$createInviteMessage ??
			$removeMessage ??
			$reactivateMessage ??
			$renameMessage ??
			$addMessage ??
			null
	);

	// Absolute invite URL for a token (PLAN §6.2 — the no-JS-copyable link text).
	function inviteUrl(token: string): string {
		return `${data.origin}/invite/${token}`;
	}

	// Absolute + relative expiry text (PLAN §6.2 — show the expiry).
	const relativeFormatter =
		typeof Intl !== 'undefined' && 'RelativeTimeFormat' in Intl
			? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
			: null;
	function expiryLabel(expiresAt: string): { absolute: string; relative: string } {
		const when = new Date(expiresAt);
		const absolute = when.toLocaleString();
		let relative = absolute;
		if (relativeFormatter) {
			const diffMs = when.getTime() - Date.now();
			const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));
			if (Math.abs(diffDays) >= 1) {
				relative = relativeFormatter.format(diffDays, 'day');
			} else {
				const diffHours = Math.round(diffMs / (60 * 60 * 1000));
				relative = relativeFormatter.format(diffHours, 'hour');
			}
		}
		return { absolute, relative };
	}

	// Copy is a PROGRESSIVE-ENHANCEMENT nicety (the link text is the no-JS
	// fallback). Best-effort clipboard write + a sonner toast on success.
	async function copyInvite(token: string) {
		const url = inviteUrl(token);
		try {
			await navigator.clipboard.writeText(url);
			toast.success('Invite link copied');
		} catch {
			toast.error('Could not copy — select the link to copy it manually');
		}
	}
</script>

<svelte:head>
	<title>Members · {data.group.name} · Pay with me</title>
</svelte:head>

<div class="space-y-6">
	<div class="flex items-start justify-between gap-2">
		<div class="space-y-1">
			<h1 class="text-2xl font-semibold tracking-tight">{data.group.name}</h1>
			<p class="text-muted-foreground text-sm">Manage who's splitting in this group.</p>
		</div>
		<div class="flex gap-2">
			<a
				href={resolve('/groups/[id]/activity', { id: data.group.id })}
				class={buttonVariants({ variant: 'outline', size: 'sm' })}
			>
				Activity
			</a>
			<a
				href={resolve('/groups/[id]/transactions', { id: data.group.id })}
				class={buttonVariants({ variant: 'outline', size: 'sm' })}
			>
				Transactions
			</a>
			<a
				href={resolve('/groups/[id]/settings', { id: data.group.id })}
				class={buttonVariants({ variant: 'outline', size: 'sm' })}
			>
				Settings
			</a>
		</div>
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
				<!-- Nothing-yet nudge (task 8.1): inline centred (the add-member form is
				     the CTA just below the Separator), so it's not a nested card. -->
				<div
					class="text-muted-foreground flex flex-col items-center gap-3 py-6 text-center"
					data-testid="members-empty"
				>
					<span
						class="bg-muted flex size-12 items-center justify-center rounded-full"
						aria-hidden="true"
					>
						<UsersIcon class="size-6" />
					</span>
					<div class="space-y-1">
						<p class="text-foreground text-base font-medium">No members yet</p>
						<p class="mx-auto max-w-prose text-sm text-pretty">
							Add a participant for anyone splitting costs — they don't need an account. Start with
							the form below.
						</p>
					</div>
				</div>
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
								<Button
									type="submit"
									variant="outline"
									size="sm"
									class="min-h-11"
									disabled={network.offline}
									title={network.offline ? OFFLINE_WRITE_MESSAGE : undefined}>Rename</Button
								>
							</form>

							<div class="flex flex-wrap gap-2">
								{#if isInactive}
									<!-- Reactivate (flag flip, §6.3). -->
									<form method="POST" action="?/reactivate" use:reactivateEnhance>
										<input type="hidden" name="memberId" value={member.id} />
										<Button
											type="submit"
											variant="outline"
											size="sm"
											class="min-h-11"
											disabled={$reactivating || network.offline}
											title={network.offline ? OFFLINE_WRITE_MESSAGE : undefined}
										>
											Reactivate
										</Button>
									</form>
								{:else}
									<!-- Remove: soft-deactivate if they have activity, else hard-delete
									     (§6.3). Destructive → confirmation gate (PLAN §10). -->
									<ConfirmSubmit
										action="?/removeMember"
										enhance={removeEnhance}
										hiddenName="memberId"
										hiddenValue={member.id}
										triggerLabel="Remove {member.displayName}"
										title="Remove {member.displayName}?"
										description={isYou
											? `${member.displayName} (you) will be removed from this group and you'll lose access — you'll be sent back to your groups.`
											: `${member.displayName} will be removed. If they have past activity they're deactivated and kept in history; otherwise they're deleted.`}
										confirmLabel="Remove"
										disabled={$removing || network.offline}
									/>
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
								<Button
									type="submit"
									disabled={$adding || network.offline}
									title={network.offline ? OFFLINE_WRITE_MESSAGE : undefined}
								>
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

	<!-- Invite links (PLAN §6.2): reusable, 7-day expiry, multiple active. Create
	     + revoke are REAL form actions (work without JS); Copy is a JS nicety. -->
	<Card.Root>
		<Card.Header>
			<Card.Title>Invite links</Card.Title>
			<Card.Description>
				Share a link so people can join this group. Links are reusable and expire after 7 days; you
				can have several active at once. When someone accepts, they choose whether to link to an
				existing member or join as a new one.
			</Card.Description>
		</Card.Header>

		<Card.Content class="space-y-4">
			{#if data.invites.length === 0}
				<!-- Nothing-yet nudge (task 8.1): inline centred (the create-invite form
				     is the CTA just below the Separator), so it's not a nested card. -->
				<div
					class="text-muted-foreground flex flex-col items-center gap-3 py-6 text-center"
					data-testid="invites-empty"
				>
					<span
						class="bg-muted flex size-12 items-center justify-center rounded-full"
						aria-hidden="true"
					>
						<LinkIcon class="size-6" />
					</span>
					<div class="space-y-1">
						<p class="text-foreground text-base font-medium">No active invite links</p>
						<p class="mx-auto max-w-prose text-sm text-pretty">
							Create a link to share so people can join this group. Links are reusable and expire
							after 7 days.
						</p>
					</div>
				</div>
			{:else}
				<ul class="divide-border divide-y" aria-label="Active invite links">
					{#each data.invites as invite (invite.id)}
						{@const expiry = expiryLabel(invite.expiresAt)}
						<li class="space-y-2 py-3">
							<div class="flex flex-wrap items-center gap-2">
								<span class="text-muted-foreground text-xs" title={expiry.absolute}>
									Expires {expiry.relative}
								</span>
							</div>

							<!-- The absolute URL as selectable text: the no-JS copy fallback. -->
							<code
								class="bg-muted block w-full overflow-x-auto rounded px-2 py-1 text-xs break-all select-all"
							>
								{inviteUrl(invite.token)}
							</code>

							<div class="flex flex-wrap gap-2">
								<!-- Copy: progressive enhancement only (clipboard + toast). -->
								<Button
									type="button"
									variant="outline"
									size="sm"
									class="min-h-11"
									onclick={() => copyInvite(invite.token)}
								>
									Copy link
								</Button>

								<!-- Revoke: a REAL form action (works without JS). Destructive →
								     confirmation gate (PLAN §10). -->
								<ConfirmSubmit
									action="?/revokeInvite"
									enhance={revokeInviteEnhance}
									hiddenName="inviteId"
									hiddenValue={invite.id}
									triggerLabel="Revoke"
									title="Revoke this invite link?"
									description="The link will stop working immediately — anyone who hasn't joined yet won't be able to use it."
									confirmLabel="Revoke"
									disabled={$revoking || network.offline}
								/>
							</div>
						</li>
					{/each}
				</ul>
			{/if}

			<Separator />

			<!-- Create a MEMBER-AGNOSTIC invite link (PLAN §6.2): a plain button, a
			     REAL form action (works without JS); the invitee chooses how to join. -->
			<form method="POST" action="?/createInvite" use:createInviteEnhance>
				<Button
					type="submit"
					disabled={$creatingInvite || network.offline}
					title={network.offline ? OFFLINE_WRITE_MESSAGE : undefined}
				>
					{$creatingInvite ? 'Creating…' : 'Create invite link'}
				</Button>
			</form>
		</Card.Content>
	</Card.Root>
</div>
