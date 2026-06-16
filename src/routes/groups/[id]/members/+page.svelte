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
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { toast } from 'svelte-sonner';
	import { addMemberSchema } from '$lib/schemas/member';
	import { createInviteSchema } from '$lib/schemas/invite';
	import * as Card from '$lib/components/ui/card';
	import * as Form from '$lib/components/ui/form';
	import * as Select from '$lib/components/ui/select';
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

	// --- Invite links (PLAN §6.2) -----------------------------------------
	// Create invite (open, or targeting an unlinked active member). Its own
	// superForm so its message surfaces on its own control.
	// svelte-ignore state_referenced_locally
	const createInviteForm = superForm(data.createInviteForm, {
		validators: zod4Client(createInviteSchema),
		resetForm: true
	});
	const {
		form: createInviteData,
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

	// Only UNLINKED, ACTIVE members are eligible invite targets (PLAN §6.2 — a
	// member-targeted link fills an empty slot). The "Open invite" option is the
	// empty value '' → normalized to an open invite server-side.
	const targetableMembers = $derived(
		data.members.filter((m) => !m.isLinked && m.deactivatedAt == null)
	);
	const selectedTargetLabel = $derived.by(() => {
		const id = $createInviteData.memberId;
		if (!id) return 'Open invite (new member)';
		return targetableMembers.find((m) => m.id === id)?.displayName ?? 'Open invite (new member)';
	});

	// Absolute invite URL for a token (PLAN §6.2 — the no-JS-copyable link text).
	function inviteUrl(token: string): string {
		return `${data.origin}/invite/${token}`;
	}

	// Look up the target member's display name for a member-targeted invite.
	function targetName(memberId: string | null): string | null {
		if (!memberId) return null;
		return data.members.find((m) => m.id === memberId)?.displayName ?? null;
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

	<!-- Invite links (PLAN §6.2): reusable, 7-day expiry, multiple active. Create
	     + revoke are REAL form actions (work without JS); Copy is a JS nicety. -->
	<Card.Root>
		<Card.Header>
			<Card.Title>Invite links</Card.Title>
			<Card.Description>
				Share a link so people can join this group. Links are reusable and expire after 7 days; you
				can have several active at once. Target an empty member slot, or leave it open to create a
				new member on accept.
			</Card.Description>
		</Card.Header>

		<Card.Content class="space-y-4">
			{#if data.invites.length === 0}
				<p class="text-muted-foreground text-sm">No active invite links — create one below.</p>
			{:else}
				<ul class="divide-border divide-y" aria-label="Active invite links">
					{#each data.invites as invite (invite.id)}
						{@const expiry = expiryLabel(invite.expiresAt)}
						{@const target = targetName(invite.memberId)}
						<li class="space-y-2 py-3">
							<div class="flex flex-wrap items-center gap-2">
								{#if target}
									<Badge variant="outline">For {target}</Badge>
								{:else}
									<Badge variant="secondary">Open</Badge>
								{/if}
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
									onclick={() => copyInvite(invite.token)}
								>
									Copy link
								</Button>

								<!-- Revoke: a REAL form action (works without JS). -->
								<form method="POST" action="?/revokeInvite" use:revokeInviteEnhance>
									<input type="hidden" name="inviteId" value={invite.id} />
									<Button type="submit" variant="outline" size="sm" disabled={$revoking}>
										Revoke
									</Button>
								</form>
							</div>
						</li>
					{/each}
				</ul>
			{/if}

			<Separator />

			<!-- Create an invite (optional target member; open if none chosen). -->
			<form method="POST" action="?/createInvite" use:createInviteEnhance class="space-y-3">
				<Form.Field form={createInviteForm} name="memberId">
					<Form.Control>
						{#snippet children({ props })}
							<Form.Label>Target member (optional)</Form.Label>
							<Select.Root type="single" bind:value={$createInviteData.memberId} name={props.name}>
								<Select.Trigger {...props} class="w-full sm:max-w-xs">
									{selectedTargetLabel}
								</Select.Trigger>
								<Select.Content>
									<Select.Item value="" label="Open invite (new member)">
										Open invite (new member)
									</Select.Item>
									{#each targetableMembers as member (member.id)}
										<Select.Item value={member.id} label={member.displayName}>
											{member.displayName}
										</Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
						{/snippet}
					</Form.Control>
					<Form.FieldErrors />
				</Form.Field>

				<Button type="submit" disabled={$creatingInvite}>
					{$creatingInvite ? 'Creating…' : 'Create invite link'}
				</Button>
			</form>
		</Card.Content>
	</Card.Root>
</div>
