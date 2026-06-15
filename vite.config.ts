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
		// Two Vitest projects (the SvelteKit-idiomatic shape):
		//   - "server": Node environment for pure logic + lib/server tests
		//     (money math, split resolution, balances, validation, …).
		//   - "client": jsdom environment for Svelte component tests
		//     (`*.svelte.test.ts`), which need a DOM.
		// Future tests extend these projects; the gate runs `vitest run` (one-shot).
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
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
			}
		]
	}
});
