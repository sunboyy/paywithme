import { describe, it, expect } from 'vitest';
import { manifest, THEME_COLOR, BACKGROUND_COLOR } from './manifest';
import { workbox } from './workbox';

// These assert the load-bearing manifest fields pinned by PLAN §11 and the
// §11.1 NetworkOnly rules. We deliberately do NOT test generated SW output —
// only the declarative config objects we own.

describe('PWA manifest (PLAN §11)', () => {
	it('uses the names/display/start_url pinned by the plan', () => {
		expect(manifest.name).toBe('Pay with me');
		expect(manifest.short_name).toBe('PayWithMe');
		expect(manifest.display).toBe('standalone');
		expect(manifest.start_url).toBe('/');
	});

	it('sets theme + background colors', () => {
		expect(manifest.theme_color).toBe(THEME_COLOR);
		expect(manifest.background_color).toBe(BACKGROUND_COLOR);
	});

	it('declares 192 + 512 + a maskable 512 icon', () => {
		const icons = manifest.icons ?? [];
		const sizes = icons.map((i) => i.sizes);
		expect(sizes).toContain('192x192');
		expect(sizes).toContain('512x512');

		const maskable = icons.filter((i) => (i.purpose ?? '').toString().includes('maskable'));
		expect(maskable).toHaveLength(1);
		expect(maskable[0].sizes).toBe('512x512');

		// All icons are PNGs under /icons/ so the manifest resolves against static/.
		for (const icon of icons) {
			expect(icon.type).toBe('image/png');
			expect(icon.src).toMatch(/^\/icons\/.+\.png$/);
		}
	});
});

describe('Workbox SW config (PLAN §11.1 — never cache authed responses)', () => {
	it('routes all /api/** traffic NetworkOnly', () => {
		const apiRule = (workbox.runtimeCaching ?? []).find((r) => r.handler === 'NetworkOnly');
		expect(apiRule).toBeDefined();
		// The pattern must match auth + data API routes.
		const pattern = apiRule!.urlPattern as RegExp;
		expect(pattern.test('/api/auth/session')).toBe(true);
		expect(pattern.test('/api/groups')).toBe(true);
	});

	it('does NOT precache HTML and disables the navigation fallback', () => {
		// navigateFallback: null => no NavigationRoute, so navigations stay
		// NetworkOnly and the server owns auth (§11.1).
		expect(workbox.navigateFallback).toBeNull();
		// Precache globs cover static/build assets only — never *.html.
		expect(workbox.globPatterns).toBeDefined();
		expect(workbox.globPatterns!.join(',')).not.toMatch(/html/);
	});

	it('does not auto-skipWaiting (prompt-to-reload supported, §11.1)', () => {
		expect(workbox.skipWaiting).toBe(false);
		expect(workbox.clientsClaim).toBe(false);
	});

	it('denylists /api/** from any future navigation fallback', () => {
		const denylist = workbox.navigateFallbackDenylist ?? [];
		expect(denylist.some((re) => re.test('/api/auth/session'))).toBe(true);
	});
});
