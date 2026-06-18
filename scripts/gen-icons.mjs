#!/usr/bin/env node
// Rasterize the committed SVG icon sources (assets/icons/*.svg) into the exact
// PNGs the Web App Manifest references (static/icons/*.png). Reproducible: edit
// the SVGs and re-run `pnpm gen:icons`.
//
// Pipeline: sharp (libvips) renders the SVG at the target pixel size, flattens
// onto the brand background (so no accidental transparency), and writes a small,
// optimized PNG.
//
// Outputs (paths/sizes are a contract with src/lib/pwa/manifest.ts and §11.1
// precaching — do not rename):
//   static/icons/icon-192.png           192x192  purpose: any
//   static/icons/icon-512.png           512x512  purpose: any
//   static/icons/icon-maskable-512.png  512x512  purpose: maskable
//   static/icons/apple-touch-icon.png   180x180  iOS home-screen (additive)
//   static/favicon.png                   48x48   browser tab (additive)
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const SLATE_900 = { r: 0x0f, g: 0x17, b: 0x28 };

const anySvg = await readFile(resolve(root, 'assets/icons/icon.svg'));
const maskableSvg = await readFile(resolve(root, 'assets/icons/icon-maskable.svg'));

/** @param {Buffer} svg @param {number} size @param {string} out */
async function render(svg, size, out) {
	await sharp(svg, { density: 384 })
		.resize(size, size, { fit: 'cover' })
		.flatten({ background: SLATE_900 })
		.png({ compressionLevel: 9, palette: true })
		.toFile(resolve(root, out));
	console.log(`  wrote ${out} (${size}x${size})`);
}

console.log('Generating PWA icons from assets/icons/*.svg …');
await render(anySvg, 192, 'static/icons/icon-192.png');
await render(anySvg, 512, 'static/icons/icon-512.png');
await render(maskableSvg, 512, 'static/icons/icon-maskable-512.png');
await render(anySvg, 180, 'static/icons/apple-touch-icon.png');
await render(anySvg, 48, 'static/favicon.png');
console.log('Done.');
