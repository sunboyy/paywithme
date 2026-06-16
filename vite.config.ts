import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-vercel';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// Deploy to Vercel on the Node.js runtime (PLAN §3 "Runtime & driver").
			// Node runtime keeps better-auth + WebAuthn and the `pg` driver simple;
			// the edge runtime is intentionally NOT used in v1.
			adapter: adapter({ runtime: 'nodejs22.x' })
		})
	],
	test: {
		// Three Vitest projects (the SvelteKit-idiomatic shape):
		//   - "server": Node environment for pure logic + lib/server tests
		//     (money math, split resolution, balances, validation, …). DB-FREE —
		//     these mock `$lib/server/db`.
		//   - "client": jsdom environment for Svelte component tests
		//     (`*.svelte.test.ts`), which need a DOM.
		//   - "integration": Node environment for REAL-DB round-trips against a
		//     local Postgres (task 3.9). These live ONLY under `tests/integration/`
		//     and are OPT-IN (`pnpm test:integration`); they are NOT part of the
		//     fast gate / CI (`pnpm test:unit`), which run WITHOUT a database.
		// The fast gate (`scripts/gate.sh`) runs only the DB-free projects via
		//   `vitest run --project server --project client`.
		//
		// IMPORTANT — keep `test:unit` DB-free: the `server` project includes only
		// `src/**`, and the integration specs live under `tests/integration/**`, so
		// `server` already cannot match them. We additionally name the integration
		// dir explicitly in `server`'s `exclude` as belt-and-braces, so even if an
		// integration spec were ever placed under `src/**` it would not be picked
		// up by `test:unit`.
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}', 'tests/integration/**']
				}
			},
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					environment: 'jsdom',
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					setupFiles: ['./vitest-setup-client.ts']
				}
			},
			{
				extends: './vite.config.ts',
				test: {
					name: 'integration',
					environment: 'node',
					// ONLY the real-DB integration specs; nothing under `src/**`.
					include: ['tests/integration/**/*.test.ts'],
					// Set `process.env.DATABASE_URL` (and ensure schema) BEFORE the app
					// `db` module reads it via `$env/dynamic/private`.
					setupFiles: ['./tests/integration/setup.ts'],
					// Run the suite SEQUENTIALLY in a single worker. The per-suite cleanup
					// deletes this suite's rows by the shared `it39-` prefix; running files
					// in parallel would let one file's cleanup clobber another's in-flight
					// rows (the prefix can't distinguish them). No file parallelism +
					// `maxWorkers: 1` keeps cleanup safe and the tests deterministic
					// (Vitest 4 flattened the old `poolOptions` to these top-level keys).
					fileParallelism: false,
					maxWorkers: 1,
					// A cold local Postgres + migrate can take a moment; give headroom.
					testTimeout: 30000,
					hookTimeout: 30000
				}
			}
		]
	}
});
