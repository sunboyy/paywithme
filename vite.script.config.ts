import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Vite config for one-off maintenance scripts run through `vite-node`
// (currently `scripts/recalculate-rounding.ts`).
//
// The app's `vite.config.ts` cannot be reused: the `sveltekit()` plugin expects
// to be driven by SvelteKit itself and throws "An impossible situation occurred"
// when vite-node loads a bare module graph through it. So this config provides
// only the two things a server-side script actually needs from the app's build:
//
//   1. the `$lib` alias, so scripts import the SAME modules the app does rather
//      than a parallel copy reached by relative path;
//   2. a stand-in for `$env/dynamic/private`, SvelteKit's runtime-env virtual
//      module (`src/lib/server/db` reads `DATABASE_URL` through it). Outside Kit
//      there is no ambient env module, and `process.env` is exactly what Kit's
//      dynamic-private env resolves to on the server anyway.
//
// Scripts are responsible for loading `.env` into `process.env` themselves
// (`process.loadEnvFile()`), since nothing here runs Kit's dotenv handling.

const ENV_DYNAMIC_PRIVATE = '$env/dynamic/private';

export default defineConfig({
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url))
		}
	},
	plugins: [
		{
			name: 'kit-dynamic-private-env-stub',
			resolveId(id) {
				return id === ENV_DYNAMIC_PRIVATE ? `\0${ENV_DYNAMIC_PRIVATE}` : null;
			},
			load(id) {
				if (id !== `\0${ENV_DYNAMIC_PRIVATE}`) return null;
				return 'export const env = process.env;';
			}
		}
	]
});
