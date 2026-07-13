// Catch-all 404 fallback for unknown `/api/v1/*` paths (PLAN §16.3).
//
// Any `/api/v1/*` path that no real resource route claims lands here and gets the
// stable 404 `not_found` envelope (PLAN §16.5) — never SvelteKit's default HTML
// 404 page. Real resource routes (e.g. `/api/v1/transactions`, a later ticket)
// are more specific than this rest-parameter route, so SvelteKit matches them
// first; only genuinely unknown paths fall through to here.
//
// `fallback` handles EVERY HTTP method in one export (GET/POST/PUT/PATCH/DELETE/…)
// so an unknown path 404s uniformly regardless of verb — there is no real
// endpoint here for which a specific verb would ever be correct.

import type { RequestHandler } from './$types';
import { notFound } from '$lib/server/api/errors';

export const fallback: RequestHandler = () => notFound();
