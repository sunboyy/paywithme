<script lang="ts">
	// How to pay one member — the panel the settle screen and member detail both
	// open on demand (issue #86; PLAN §17.3–§17.4).
	//
	// This is the moment the whole feature exists for: the payer is holding their
	// banking app. So the panel is written for that moment and nothing else.
	//
	// ── The name check is TEXT, not a hint ───────────────────────────────────────
	// Whenever any method renders, the panel states the comparison the payer must
	// make (PLAN §17.2): their banking app will show the account holder's name, and
	// it has to match the one here. No format check can catch a valid-but-wrong
	// account number — one transposed digit that happens to be somebody's real
	// account sends real money to a stranger — so this is the only defence there is.
	// It is therefore a sentence above the details, never a tooltip, never an icon,
	// and never inside the "other ways to pay" fold.
	//
	// ── Only the FIRST method is shown ───────────────────────────────────────────
	// Order is the preference (PLAN §17.1). The rest sit behind a native `<details>`
	// so the payer is offered one answer, not a menu, and the fold still opens with
	// JS disabled.
	//
	// ── Nothing here knows a rail ────────────────────────────────────────────────
	// `load` sends resolved fields (`$lib/receiving-method-view`); this walks them
	// and branches only on a field's PAYER ROLE — which value to copy, which name to
	// check. Adding a country later is a registry entry (ADR-0016), not an edit here.
	//
	// ── The code leads, when there is one (issue #88; PLAN §17.4; ADR-0017) ──────
	// A method whose rail could encode this transfer arrives with a QR carrying the
	// amount, and it goes FIRST: scanning it is the whole point — no digits typed,
	// no figure typed, no transposed digit to make. The raw value then sits behind a
	// reveal, because a receiving profile is visible to every co-member of every
	// shared group (PLAN §17.3) and a national ID is a far more sensitive thing to
	// print in a list than a phone number.
	//
	// That reveal is OBFUSCATION, NOT PROTECTION: the proxy is inside the code in
	// plain digits, and anyone who screenshots it has the number. So the summary
	// says "show", and nothing anywhere claims the code hides anything.
	//
	// The name check is UNCHANGED by any of this. A QR proves nothing about who owns
	// the account — the payload carries no name at all — so the instruction and the
	// holder name stay exactly where they were, outside every fold.
	//
	// Copy is progressive enhancement: every value is real selectable text
	// (`select-all`), so a no-JS payer copies it by hand.
	//
	// The panel names the member in every empty state but one: when the empty profile
	// is the VIEWER'S OWN (PLAN §17.4 case 3), the same blank turns from a dead end
	// into a one-tap fix, so it is addressed to them and carries the link to the
	// editor. Which of the two it is, is decided on the server (`own-empty`).
	import { Button } from '$lib/components/ui/button';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import CheckIcon from '@lucide/svelte/icons/check';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type {
		ReceivingFieldView,
		ReceivingMethodView,
		ReceivingProfileView
	} from '$lib/receiving-method-view';

	let {
		view,
		displayName,
		inviteUrl = null,
		invitesHref,
		receivingSettingsHref
	}: {
		/** The member's receiving details, as this viewer may see them. */
		view: ReceivingProfileView;
		/** Whose details these are — named in every empty state but `own-empty`. */
		displayName: string;
		/** The group's newest active invite link, or null when it has none (PLAN §6.2). */
		inviteUrl?: string | null;
		/** Where invite links are created and revoked — the members screen. */
		invitesHref: string;
		/** The viewer's own receiving editor — `/settings/receiving` (PLAN §17.4). */
		receivingSettingsHref: string;
	} = $props();

	/** Which value was copied last, so one button at a time reads "Copied". */
	let copiedKey = $state<string | null>(null);
	let copyFailed = $state(false);
	/** The pending reset, cancelled on the next copy so a second one gets its full 2s. */
	let resetTimer: ReturnType<typeof setTimeout> | undefined;

	async function copy(key: string, value: string) {
		copyFailed = false;
		try {
			await navigator.clipboard.writeText(value);
			copiedKey = key;
			clearTimeout(resetTimer);
			resetTimer = setTimeout(() => (copiedKey = null), 2000);
		} catch {
			// Blocked permission or an insecure context — say so, rather than doing
			// nothing visible. The value itself is on screen and selectable.
			copyFailed = true;
		}
	}
</script>

{#snippet fieldRow(m: ReceivingMethodView, field: ReceivingFieldView)}
	{@const key = `${m.id}:${field.label}`}
	<div class="space-y-0.5">
		<dt class="text-xs text-muted-foreground">{field.label}</dt>
		<dd class="flex items-start justify-between gap-2">
			<span class="min-w-0 break-words select-all">{field.value}</span>
			{#if field.payerRole === 'copy'}
				<!-- Only the value a payer types into their bank goes on the
				     clipboard: copying the whole line would paste a bank name and
				     a person's name into an account-number box. -->
				<Button
					type="button"
					variant="outline"
					size="sm"
					class="min-h-9 shrink-0 gap-1"
					onclick={() => copy(key, field.value)}
					aria-label="Copy {field.label.toLowerCase()}"
				>
					{#if copiedKey === key}
						<CheckIcon class="size-4" aria-hidden="true" />
						Copied
					{:else}
						<CopyIcon class="size-4" aria-hidden="true" />
						Copy
					{/if}
				</Button>
			{/if}
		</dd>
	</div>
{/snippet}

{#snippet method(m: ReceivingMethodView)}
	<div class="space-y-3 rounded-md border bg-background p-3" data-testid="receiving-method">
		<p class="text-sm font-medium">{m.railLabel}</p>

		{#if m.fields}
			<!-- With a code on screen, the value it already contains moves behind the
			     reveal; everything else — the holder name above all — stays put. Without
			     one, `behindReveal` is empty and this renders exactly as it did before. -->
			{@const behindReveal = m.qr ? m.fields.filter((f) => f.payerRole === 'copy') : []}
			{@const alwaysShown = m.fields.filter((f) => !behindReveal.includes(f))}

			{#if m.qr}
				<figure class="space-y-2" data-testid="receiving-qr">
					<!-- DARK ON LIGHT, in both themes: the ground is painted here rather than
					     inherited, because a code drawn over a dark background is one no
					     scanner will read. The quiet zone is inside the viewBox. -->
					<div class="mx-auto w-full max-w-56 rounded-md border bg-white p-2">
						<svg
							viewBox="0 0 {m.qr.size} {m.qr.size}"
							class="block h-auto w-full"
							shape-rendering="crispEdges"
							role="img"
							aria-label="QR code to pay {displayName} {m.qr.amountFormatted}"
						>
							<rect width={m.qr.size} height={m.qr.size} fill="#ffffff" />
							<path d={m.qr.path} fill="#000000" />
						</svg>
					</div>
					<figcaption class="text-center text-sm text-muted-foreground">
						Scan with your banking app — {m.qr.amountFormatted} is already in the code.
					</figcaption>
				</figure>
			{/if}

			<dl class="space-y-2.5">
				{#each alwaysShown as field (field.label)}
					{@render fieldRow(m, field)}
				{/each}
			</dl>

			{#if behindReveal.length > 0}
				<!-- Native <details>, so the digits are one tap away with JS disabled. The
				     summary says only "show": the code is not a hiding place, and copy that
				     implied it were would be a promise this app cannot keep. -->
				<details data-testid="receiving-reveal">
					<summary
						class="inline-flex min-h-11 cursor-pointer list-none items-center text-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden"
					>
						Show {behindReveal[0].label}
					</summary>
					<dl class="space-y-2.5 pt-2">
						{#each behindReveal as field (field.label)}
							{@render fieldRow(m, field)}
						{/each}
					</dl>
				</details>
			{/if}
		{:else}
			<!-- The rail refuses to render these details (see `ReceivingMethodView`).
			     Half an account number is worse than none when the next step is a
			     transfer, so say what happened and who can fix it. -->
			<p class="text-sm text-destructive">
				These details can’t be shown right now. Ask {displayName} to check them.
			</p>
		{/if}
	</div>
{/snippet}

{#if view.state === 'unlinked'}
	<!-- Empty state 1 (PLAN §17.4): nothing will ever appear here until they join,
	     so this is the invite nudge rather than a "not yet" placeholder. -->
	<div class="space-y-2" data-testid="receiving-unlinked">
		<p class="text-sm font-medium">No account yet — invite them</p>
		<p class="text-sm text-muted-foreground">
			{displayName} is a participant in this group, not an account. They can add how they want to be paid
			once they join.
		</p>
		{#if inviteUrl}
			<!-- The ABSOLUTE link, rendered as its own text: that is what gets pasted
			     into a chat, and it stays selectable (and copyable) with JS disabled.
			     `inviteUrl` is built on the server from the request origin, so it is
			     already a resolved URL and needs no `resolve()`. Disable/enable PAIR,
			     not `-next-line`: the <a> spans several lines. -->
			<!-- eslint-disable svelte/no-navigation-without-resolve -->
			<a
				href={inviteUrl}
				class="block w-full overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs break-all underline-offset-4 select-all hover:underline"
				data-testid="receiving-invite-link"
			>
				{inviteUrl}
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
			<Button
				type="button"
				variant="outline"
				size="sm"
				class="min-h-11 gap-1"
				onclick={() => copy('invite', inviteUrl)}
			>
				{#if copiedKey === 'invite'}
					<CheckIcon class="size-4" aria-hidden="true" />
					Copied
				{:else}
					<CopyIcon class="size-4" aria-hidden="true" />
					Copy invite link
				{/if}
			</Button>
		{:else}
			<!-- No active link to hand over. Creating one is a mutation, so it belongs
			     on the members screen — never in a page `load`. -->
			<Button variant="outline" size="sm" class="min-h-11" href={invitesHref}>
				Create an invite link
			</Button>
		{/if}
	</div>
{:else if view.state === 'own-empty'}
	<!-- Empty state 3 (PLAN §17.4): this profile is the viewer's own. It is the
	     whole adoption strategy — the one moment they are looking at a screen that
	     says someone owes them money, which is the only time bank details are worth
	     typing. So it is a link to the editor, not the sentence a third party gets. -->
	<div class="space-y-2" data-testid="receiving-own-empty">
		<p class="text-sm text-muted-foreground">
			You haven’t added a receiving method, so there’s nothing here for them to pay into.
		</p>
		<Button
			variant="link"
			href={receivingSettingsHref}
			class="h-auto min-h-11 justify-start p-0 text-sm"
		>
			Add how people should pay you →
		</Button>
	</div>
{:else if view.state === 'no-methods'}
	<!-- Empty state 2 (PLAN §17.4): exactly one sentence. v1 has no notifications,
	     so anything that sounds like "we'll remind them" would be a lie. -->
	<p class="text-sm text-muted-foreground" data-testid="receiving-no-methods">
		{displayName} hasn’t added a receiving method.
	</p>
{:else}
	<div class="space-y-3">
		<!-- PLAN §17.2, stated as an instruction. Above the details and outside the
		     fold, so it is read before anything is copied. -->
		<p
			class="flex gap-2 rounded-md border border-foreground/20 bg-muted p-3 text-sm"
			data-testid="receiving-name-check"
		>
			<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			<span>
				<strong class="font-medium">Check the name before you confirm.</strong> Your banking app will
				show the account holder’s name — it must match the name shown here. If it doesn’t match, stop:
				the money is going to someone else.
			</span>
		</p>

		{@render method(view.methods[0])}

		{#if view.methods.length > 1}
			<!-- Order is the preference (PLAN §17.1): everything after the first sits
			     behind this fold. Native `<details>`, so it opens without JS. -->
			<details data-testid="receiving-other-ways">
				<summary
					class="inline-flex min-h-11 cursor-pointer list-none items-center text-sm font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden"
				>
					Other ways to pay {displayName}
				</summary>
				<div class="space-y-3 pt-2">
					{#each view.methods.slice(1) as m (m.id)}
						{@render method(m)}
					{/each}
				</div>
			</details>
		{/if}
	</div>
{/if}

{#if copyFailed}
	<p class="pt-2 text-sm text-destructive" role="alert">
		Couldn’t copy — select the text and copy it manually.
	</p>
{/if}
