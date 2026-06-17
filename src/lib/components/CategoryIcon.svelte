<script lang="ts">
	// Render a transaction category's lucide icon by its (kebab-case) `icon` name
	// (PLAN §7.3). The canonical icon names live in `$lib/categories` (`CATEGORIES`).
	//
	// lucide-svelte exposes each icon as its own module; importing per-name keeps
	// tree-shaking. We map the FIXED set of category icon names (14 categories, but
	// "Other" shares `shapes`, so fewer distinct icons) to their dedicated imports.
	// A category icon is always one of these — there is no user-supplied icon — so
	// the map is exhaustive. An unknown name falls back to the generic `shapes`
	// glyph rather than rendering nothing.
	import type { Component } from 'svelte';
	import Utensils from '@lucide/svelte/icons/utensils';
	import ShoppingBasket from '@lucide/svelte/icons/shopping-basket';
	import Car from '@lucide/svelte/icons/car';
	import House from '@lucide/svelte/icons/house';
	import Zap from '@lucide/svelte/icons/zap';
	import Clapperboard from '@lucide/svelte/icons/clapperboard';
	import ShoppingBag from '@lucide/svelte/icons/shopping-bag';
	import Plane from '@lucide/svelte/icons/plane';
	import HeartPulse from '@lucide/svelte/icons/heart-pulse';
	import Shapes from '@lucide/svelte/icons/shapes';
	import Handshake from '@lucide/svelte/icons/handshake';
	import Banknote from '@lucide/svelte/icons/banknote';
	import Landmark from '@lucide/svelte/icons/landmark';

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type IconComponent = Component<any>;

	const ICONS: Record<string, IconComponent> = {
		utensils: Utensils,
		'shopping-basket': ShoppingBasket,
		car: Car,
		house: House,
		zap: Zap,
		clapperboard: Clapperboard,
		'shopping-bag': ShoppingBag,
		plane: Plane,
		'heart-pulse': HeartPulse,
		shapes: Shapes,
		handshake: Handshake,
		banknote: Banknote,
		landmark: Landmark
	};

	let { name, class: className }: { name: string; class?: string } = $props();

	const Icon = $derived(ICONS[name] ?? Shapes);
</script>

<Icon class={className} />
