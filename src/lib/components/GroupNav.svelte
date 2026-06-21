<script lang="ts">
	// Shared sub-navigation for a group's pages (overview / transactions / settle /
	// members / activity / settings). ONE source of truth for the destinations,
	// their order, and the active state, so every group page navigates identically
	// (the pages previously each hand-rolled their own divergent link rows).
	//
	// Renders as a mobile-first horizontal tab bar (GitHub-repo-style): the active
	// section carries `aria-current="page"` and a coloured underline; every tab is an
	// obvious, icon-labelled control (not bare underline-on-hover text). The bar
	// scrolls horizontally on narrow viewports so all sections stay reachable.
	import { resolve } from '$app/paths';
	import HouseIcon from '@lucide/svelte/icons/house';
	import ReceiptIcon from '@lucide/svelte/icons/receipt';
	import HandshakeIcon from '@lucide/svelte/icons/handshake';
	import UsersIcon from '@lucide/svelte/icons/users';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import SettingsIcon from '@lucide/svelte/icons/settings';

	export type GroupSection =
		| 'overview'
		| 'transactions'
		| 'settle'
		| 'members'
		| 'activity'
		| 'settings';

	let { groupId, current }: { groupId: string; current: GroupSection } = $props();

	const items = $derived([
		{
			key: 'overview',
			label: 'Overview',
			icon: HouseIcon,
			href: resolve('/groups/[id]', { id: groupId })
		},
		{
			key: 'transactions',
			label: 'Transactions',
			icon: ReceiptIcon,
			href: resolve('/groups/[id]/transactions', { id: groupId })
		},
		{
			key: 'settle',
			label: 'Settle up',
			icon: HandshakeIcon,
			href: resolve('/groups/[id]/settle', { id: groupId })
		},
		{
			key: 'members',
			label: 'Members',
			icon: UsersIcon,
			href: resolve('/groups/[id]/members', { id: groupId })
		},
		{
			key: 'activity',
			label: 'Activity',
			icon: HistoryIcon,
			href: resolve('/groups/[id]/activity', { id: groupId })
		},
		{
			key: 'settings',
			label: 'Settings',
			icon: SettingsIcon,
			href: resolve('/groups/[id]/settings', { id: groupId })
		}
	]);
</script>

<nav aria-label="Group sections" class="overflow-x-auto border-b">
	<!-- Each `item.href` is already a resolved path (built with `resolve()` above),
	     so the navigation-without-resolve rule is satisfied at the source. -->
	<!-- eslint-disable svelte/no-navigation-without-resolve -->
	<ul class="flex min-w-max gap-1">
		{#each items as item (item.key)}
			{@const Icon = item.icon}
			{@const active = item.key === current}
			<li>
				<a
					href={item.href}
					aria-current={active ? 'page' : undefined}
					class="flex items-center gap-1.5 border-b-2 p-3 text-sm font-medium whitespace-nowrap transition-colors {active
						? 'border-primary text-foreground'
						: 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'}"
				>
					<Icon class="size-4" aria-hidden="true" />
					{item.label}
				</a>
			</li>
		{/each}
	</ul>
	<!-- eslint-enable svelte/no-navigation-without-resolve -->
</nav>
