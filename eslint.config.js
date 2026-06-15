import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
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
	}
);
