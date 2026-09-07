<script lang="ts">
	// Sub-navigation for a group's pages (overview / transactions / settle /
	// members / activity / settings). ONE source of truth for the destinations,
	// their order, and the active state, so every group page navigates identically.
	//
	// The bar itself is `TabNav`, shared with account settings — see that component
	// for the scrolling / active-state behaviour.
	import { resolve } from '$app/paths';
	import TabNav from '$lib/components/TabNav.svelte';
	import HouseIcon from '@lucide/svelte/icons/house';
	import ReceiptIcon from '@lucide/svelte/icons/receipt';
	import HandshakeIcon from '@lucide/svelte/icons/handshake';
	import UsersIcon from '@lucide/svelte/icons/users';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import SettingsIcon from '@lucide/svelte/icons/settings';

	export type GroupSection =
		'overview' | 'transactions' | 'settle' | 'members' | 'activity' | 'settings';

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

<TabNav label="Group sections" {items} {current} />
