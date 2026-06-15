// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

// Derive Locals types from better-auth's inferred Session so they stay in sync
// with the auth config (PLAN §5.7). `import type` is erased at build time, so
// this does NOT drag server code into client bundles.
import type { Auth } from '$lib/server/auth';

type BetterAuthSession = Auth['$Infer']['Session'];

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			// Resolved once per request in `hooks.server.ts`; `null` when anonymous.
			user: BetterAuthSession['user'] | null;
			session: BetterAuthSession['session'] | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}

		// Typed status message for sveltekit-superforms (task 2.5 `/register`).
		// superforms resolves the form message type from `App.Superforms.Message`,
		// so this namespace MUST be nested inside `App`. `sent` carries the target
		// email for the confirmation; `error` a generic message. Same shape
		// regardless of account existence (PLAN §12).
		namespace Superforms {
			type Message = { type: 'sent' | 'error'; text: string };
		}
	}
}

export {};
