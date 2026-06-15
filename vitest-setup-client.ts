import '@testing-library/jest-dom/vitest';

// jsdom doesn't implement these APIs that Svelte / component code may touch.
// Stub them so client (`*.svelte.test.ts`) tests don't crash on import.
Object.defineProperty(window, 'matchMedia', {
	writable: true,
	enumerable: true,
	value: (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false
	}),
	configurable: true
});
