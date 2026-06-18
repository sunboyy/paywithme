# App icons — PLACEHOLDERS

These solid `#0f172a` (slate-900) PNGs are **placeholders** generated in task
7.1 so the Web App Manifest resolves and the build does not 404. They are
referenced by `src/lib/pwa/manifest.ts`.

**Task 7.6 replaces them with designed icons at these exact paths** (same file
names / sizes), so the manifest does not need to change:

- `icon-192.png` — 192×192, `purpose: any`
- `icon-512.png` — 512×512, `purpose: any`
- `icon-maskable-512.png` — 512×512, `purpose: maskable` (keep safe-zone padding)
