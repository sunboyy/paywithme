// Ambient types for the PWA virtual module emitted by `@vite-pwa/sveltekit`
// (PLAN §11). This brings `virtual:pwa-register` into scope so the dynamic
// import in `src/lib/pwa/register.svelte.ts` typechecks under svelte-check.
//
// We declare the module locally (mirroring vite-plugin-pwa's `vanillajs.d.ts`)
// rather than `/// <reference types="vite-plugin-pwa/client" />`, because
// `vite-plugin-pwa` is a TRANSITIVE dep (we depend on `@vite-pwa/sveltekit`),
// so a bare `vite-plugin-pwa/client` reference is not guaranteed to resolve
// under `moduleResolution: bundler`, and `@vite-pwa/sveltekit` does not itself
// re-export the option type. The option subset declared here is exactly what
// `register.svelte.ts` uses.
//
// The virtual module only RESOLVES at build time when the PWA plugin emits a
// service worker; this declaration is purely for the type-checker. The runtime
// import is dynamic + guarded, so a missing module is a safe no-op.
declare module 'virtual:pwa-register' {
	export interface RegisterSWOptions {
		/** When false, the SW does not seize control / reload on its own. */
		immediate?: boolean;
		/** A new SW version is installed and waiting (prompt-to-reload, §11.1). */
		onNeedRefresh?: () => void;
		/** The SW finished precaching the static shell. */
		onOfflineReady?: () => void;
		/** The SW registered successfully. */
		onRegisteredSW?: (
			swScriptUrl: string,
			registration: ServiceWorkerRegistration | undefined
		) => void;
		/** Registration failed (kept non-fatal: auth/data are server-driven). */
		onRegisterError?: (error: unknown) => void;
	}

	/**
	 * Registers the service worker, returning a callback that reloads the page
	 * so a waiting worker can take control.
	 */
	export function registerSW(options?: RegisterSWOptions): (reloadPage?: boolean) => Promise<void>;
}
