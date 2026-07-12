// Shared POST-create + idempotency wiring for the two `/api/v1` write creates
// (`…/transactions`, `…/settle-up`) — PLAN §16.6.
//
// Both create routes do the same envelope dance: build the create response, and —
// ONLY when an `Idempotency-Key` header is present — route it through
// {@link withIdempotency} so a retry replays / conflicts instead of re-executing.
// This helper is that ONE place, so the routes don't each re-implement the header
// check + `json()` wiring. Header absent → the create runs directly (the current
// at-least-once behavior, unchanged, §16.6).

import { json } from '@sveltejs/kit';
import {
	withIdempotency,
	createDbIdempotencyStore,
	type IdempotentResponse,
	type IdempotencyStore
} from './idempotency';

/**
 * Produce the create's `Response`, honoring an `Idempotency-Key` header when given.
 *
 * `build` runs the actual create (service call + DTO) and returns
 * `{ status, body }`. With a header, `build` runs AT MOST ONCE per (key + body):
 * a same-body retry replays the stored response, a different body → 409
 * `key_reused`, a concurrent retry → 409 `in_progress` (all raised by
 * {@link withIdempotency}, mapped to the envelope by `withWriteErrorHandling`).
 * Without a header, `build` runs directly.
 */
export async function runCreateWithIdempotency({
	keyId,
	idempotencyKeyHeader,
	rawBody,
	build,
	store = createDbIdempotencyStore()
}: {
	keyId: string;
	idempotencyKeyHeader: string | null;
	rawBody: string;
	build: () => Promise<IdempotentResponse>;
	store?: IdempotencyStore;
}): Promise<Response> {
	if (!idempotencyKeyHeader) {
		const { status, body } = await build();
		return json(body, { status });
	}

	const { status, body } = await withIdempotency({
		keyId,
		idempotencyKey: idempotencyKeyHeader,
		rawBody,
		store,
		fn: build
	});
	return json(body, { status });
}
