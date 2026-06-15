import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import betterTailwindcss from 'eslint-plugin-better-tailwindcss';
import globals from 'globals';
import ts from 'typescript-eslint';

export default ts.config(
	{
		// Generated / build output. shadcn-svelte components are added via its CLI
		// (CLAUDE.md forbids hand-authoring them) and the Drizzle migration output is
		// machine-generated — neither should be linted. Build/cache dirs are ignored too.
		ignores: [
			'.svelte-kit/**',
			'.vercel/**',
			'build/**',
			'dist/**',
			'node_modules/**',
			'drizzle/**',
			'coverage/**',
			'test-results/**',
			'playwright-report/**',
			'playwright/.cache/**',
			'src/lib/components/ui/**'
		]
	},
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	prettier,
	...svelte.configs.prettier,
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node }
		},
		rules: {
			// typescript-eslint recommends disabling no-undef on TS projects; the
			// type-checker already catches undefined references.
			// https://typescript-eslint.io/troubleshooting/faqs/general#i-get-errors-from-the-no-undef-rule
			'no-undef': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				parser: ts.parser,
				extraFileExtensions: ['.svelte']
			}
		}
	},
	{
		// Catch non-canonical Tailwind classes in the gate (e.g. the arbitrary
		// variant `supports-[backdrop-filter]:` instead of the canonical
		// `supports-backdrop-filter:`). This is the CLI-runnable equivalent of the
		// Tailwind CSS IntelliSense `suggestCanonicalClasses` editor diagnostic, so
		// `pnpm lint` (and thus the gate + CI) enforces it, not just the editor.
		// Tailwind v4: resolve utilities from the app stylesheet entry point.
		// Auto-fixable with `eslint --fix`. Generated shadcn components in
		// `src/lib/components/ui/**` are ignored above (CLI-managed, not hand-authored).
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js', '**/*.ts', '**/*.js'],
		plugins: { 'better-tailwindcss': betterTailwindcss },
		settings: { 'better-tailwindcss': { entryPoint: 'src/app.css' } },
		rules: {
			'better-tailwindcss/enforce-canonical-classes': 'error'
		}
	}
);
