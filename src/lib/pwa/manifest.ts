// Web App Manifest for the installable PWA (PLAN §11).
//
// Factored into its own importable module (rather than inlined in
// `vite.config.ts`) so the load-bearing fields can be unit-tested without
// touching generated service-worker output. `vite.config.ts` imports this and
// hands it to `SvelteKitPWA({ manifest })`.
//
// Naming is pinned by PLAN §11:
//   - name       = "Pay with me"
//   - short_name = "PayWithMe"
//   - display    = standalone
//   - start_url  = "/"
//   - icons      = 192 + 512 (+ a maskable 512)
//
// The icon files referenced here are the designed split-coin icons authored in
// task 7.6 (sources in assets/icons/, rasterized by scripts/gen-icons.mjs).
import type { SvelteKitPWAOptions } from '@vite-pwa/sveltekit';

// Derive the manifest option type straight from the plugin (which extends
// `Partial<VitePWAOptions>`). `vite-plugin-pwa` is a transitive dep that isn't
// directly importable, so we pull the type through the package we depend on.
// The plugin's `manifest` field is `Partial<ManifestOptions> | false`; we want
// the object arm only.
type ManifestConfig = Exclude<NonNullable<SvelteKitPWAOptions['manifest']>, boolean>;

// Brand colors. Kept here as the single source; src/app.html's
// <meta name="theme-color"> must mirror THEME_COLOR. slate-900 / white are
// retained: slate-900 is the icon background and the app's neutral/slate brand
// (PLAN §10), and white keeps the install splash clean on light-default mobile.
export const THEME_COLOR = '#0f172a'; // slate-900 — app chrome / status bar tint
export const BACKGROUND_COLOR = '#ffffff'; // splash background

export const manifest: ManifestConfig = {
	name: 'Pay with me',
	short_name: 'PayWithMe',
	description: 'Split shared expenses and settle up with the people you pay with.',
	display: 'standalone',
	start_url: '/',
	scope: '/',
	theme_color: THEME_COLOR,
	background_color: BACKGROUND_COLOR,
	icons: [
		{
			src: '/icons/icon-192.png',
			sizes: '192x192',
			type: 'image/png',
			purpose: 'any'
		},
		{
			src: '/icons/icon-512.png',
			sizes: '512x512',
			type: 'image/png',
			purpose: 'any'
		},
		{
			// Maskable variant so Android/adaptive icons render without letterboxing.
			src: '/icons/icon-maskable-512.png',
			sizes: '512x512',
			type: 'image/png',
			purpose: 'maskable'
		}
	]
};
