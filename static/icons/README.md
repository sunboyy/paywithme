# App icons

Designed PWA icons for **Pay with me** (task 7.6 — PLAN #25). These are the real
icons, not placeholders.

## The mark

A single **coin split into two equal halves** down a vertical seam — the literal
"split the bill / share the cost" mark for an expense-splitting app. Two dots
straddle the seam, reading as a division sign ("split evenly") and as two people
sharing one coin.

Palette (PLAN §10 neutral/slate):

- background: slate-900 `#0f172a` (matches `THEME_COLOR`)
- left half: slate-100 `#f1f5f9`
- right half: slate-400 `#94a3b8`
- seam + dots: slate-900 `#0f172a` (carved out of the coin)

The mid-slate right half keeps the coin legible on both light and dark device
chrome.

## Source → PNG pipeline

SVG sources live in [`assets/icons/`](../../assets/icons):

- `icon.svg` — full-bleed ("any") artwork, rounded-card background.
- `icon-maskable.svg` — same mark scaled into the maskable safe zone (coin
  radius 140 on a 512 canvas ⇒ farthest edge at ~55% of the half-canvas, well
  inside the inner-80%-diameter safe circle) with the slate-900 background
  filling the full bleed.

[`scripts/gen-icons.mjs`](../../scripts/gen-icons.mjs) rasterizes them with
`sharp` (a devDependency), flattening onto the brand background so the PNGs are
never transparent.

**Regenerate after editing an SVG:**

```sh
pnpm gen:icons
```

## Outputs (paths/sizes are a contract with `src/lib/pwa/manifest.ts`)

- `icon-192.png` — 192×192, `purpose: any`
- `icon-512.png` — 512×512, `purpose: any`
- `icon-maskable-512.png` — 512×512, `purpose: maskable`
- `apple-touch-icon.png` — 180×180, iOS home screen (wired in `src/app.html`)
- `../favicon.png` — 48×48, browser tab (wired in `src/app.html`)
