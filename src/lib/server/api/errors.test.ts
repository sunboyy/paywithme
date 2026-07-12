// Unit tests for the shared `/api/v1` error envelope + 500 normalizer (§16.5).
//
// These assert the WIRE CONTRACT: the exact `{ error: { code, message, details? } }`
// shape, the HTTP status per code, `application/json`, the field-level
// `validation_error` details, the 404 conflation discipline, and that
// `handleApiError` never leaks internals while propagating control-flow throws.

import { describe, it, expect, vi } from 'vitest';
import { error, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import {
	API_ERROR_CODES,
	apiError,
	apiErrorEnvelope,
	badRequest,
	unauthorized,
	forbiddenScope,
	notFound,
	rateLimited,
	conflict,
	internalError,
	validationError,
	handleApiError,
	withApiErrorHandling
} from './errors';

/** Read a Response as `{ status, contentType, body }`. */
async function read(res: Response) {
	return {
		status: res.status,
		contentType: res.headers.get('content-type'),
		body: await res.json()
	};
}

describe('apiError / apiErrorEnvelope', () => {
	const cases: Array<[keyof typeof API_ERROR_CODES, number]> = [
		['bad_request', 400],
		['unauthorized', 401],
		['forbidden_scope', 403],
		['not_found', 404],
		['validation_error', 422],
		['rate_limited', 429],
		['conflict', 409],
		['internal_error', 500]
	];

	it.each(cases)('code %s → HTTP %i with the stable envelope shape', async (code, status) => {
		const { status: got, contentType, body } = await read(apiError(code));
		expect(got).toBe(status);
		expect(contentType).toContain('application/json');
		expect(body).toEqual({ error: { code, message: expect.any(String) } });
		// The `code` string is exactly the constant (public contract).
		expect(body.error.code).toBe(API_ERROR_CODES[code]);
	});

	it('uses an overriding message when provided', async () => {
		const { body } = await read(apiError('not_found', 'No such transaction.'));
		expect(body).toEqual({ error: { code: 'not_found', message: 'No such transaction.' } });
	});

	it('omits `details` from the envelope when none is given', () => {
		const env = apiErrorEnvelope('bad_request');
		expect('details' in env.error).toBe(false);
	});

	it('includes `details` verbatim when provided', () => {
		const env = apiErrorEnvelope('rate_limited', 'slow down', { scope: 'write', limit: 10 });
		expect(env.error.details).toEqual({ scope: 'write', limit: 10 });
	});
});

describe('per-code convenience helpers', () => {
	it('map to the right code + status', async () => {
		expect((await read(badRequest())).status).toBe(400);
		expect((await read(unauthorized())).status).toBe(401);
		expect((await read(forbiddenScope())).status).toBe(403);
		expect((await read(notFound())).status).toBe(404);
		expect((await read(rateLimited())).status).toBe(429);
		expect((await read(conflict())).status).toBe(409);
		expect((await read(internalError())).status).toBe(500);

		expect((await read(forbiddenScope())).body.error.code).toBe('forbidden_scope');
	});

	it('conflict() carries the §16.6 `reason` detail while the code stays `conflict`', async () => {
		const { status, body } = await read(conflict('Key reused.', { reason: 'key_reused' }));
		expect(status).toBe(409);
		expect(body.error.code).toBe('conflict');
		expect(body.error.message).toBe('Key reused.');
		expect(body.error.details).toEqual({ reason: 'key_reused' });
	});

	it('unauthorized() matches the #14 hook 401 shape (code + human message)', async () => {
		const { status, body } = await read(unauthorized());
		expect(status).toBe(401);
		expect(body).toEqual({ error: { code: 'unauthorized', message: 'Authentication required.' } });
	});
});

describe('notFound() — absent vs no-access conflation (§16.5 / §12)', () => {
	it('produces an IDENTICAL envelope for "absent" and "no-access"', async () => {
		// The helper is the discipline: a route returns the same 404 whether the
		// resource is missing or the caller simply can't see it, so existence never
		// leaks. Here we prove both paths yield the byte-identical envelope.
		const absent = await read(notFound());
		const noAccess = await read(notFound());
		expect(absent.status).toBe(404);
		expect(noAccess.status).toBe(404);
		expect(absent.body).toEqual(noAccess.body);
		expect(absent.body).toEqual({
			error: { code: 'not_found', message: expect.any(String) }
		});
	});
});

describe('validationError — field-level details (§16.5)', () => {
	it('flattens a ZodError into `{ formErrors, fieldErrors }` details', async () => {
		const schema = z.object({ amount: z.number(), title: z.string().min(1) });
		const result = schema.safeParse({ amount: 'nope', title: '' });
		expect(result.success).toBe(false);

		const { status, body } = await read(validationError(result.error!));
		expect(status).toBe(422);
		expect(body.error.code).toBe('validation_error');
		// An agent can read exactly which field failed and why → self-correct.
		expect(body.error.details.fieldErrors.amount).toEqual([expect.any(String)]);
		expect(body.error.details.fieldErrors.title).toEqual([expect.any(String)]);
		expect(Array.isArray(body.error.details.formErrors)).toBe(true);
	});

	it('passes a pre-built details object through unchanged', async () => {
		const { body } = await read(validationError({ fieldErrors: { email: ['required'] } }));
		expect(body.error.details).toEqual({ fieldErrors: { email: ['required'] } });
	});
});

describe('handleApiError — 500 normalizer seam (§16.3)', () => {
	it('collapses an unexpected error to a generic 500 and never leaks its message', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { status, body } = await read(handleApiError(new Error('DB password is hunter2')));
		expect(status).toBe(500);
		expect(body).toEqual({ error: { code: 'internal_error', message: expect.any(String) } });
		expect(JSON.stringify(body)).not.toContain('hunter2');
		spy.mockRestore();
	});

	it('maps a thrown error(404, …) to the not_found envelope, reusing its message', async () => {
		let thrown: unknown;
		try {
			error(404, 'Group not found');
		} catch (e) {
			thrown = e;
		}
		const { status, body } = await read(handleApiError(thrown));
		expect(status).toBe(404);
		expect(body).toEqual({ error: { code: 'not_found', message: 'Group not found' } });
	});

	it('maps a thrown error(403, …) to forbidden_scope', async () => {
		let thrown: unknown;
		try {
			error(403, 'nope');
		} catch (e) {
			thrown = e;
		}
		const { status, body } = await read(handleApiError(thrown));
		expect(status).toBe(403);
		expect(body.error.code).toBe('forbidden_scope');
	});

	it('does NOT leak the message of a thrown error(500, …)', async () => {
		let thrown: unknown;
		try {
			error(500, 'stack trace with secrets');
		} catch (e) {
			thrown = e;
		}
		const { status, body } = await read(handleApiError(thrown));
		expect(status).toBe(500);
		expect(JSON.stringify(body)).not.toContain('secrets');
	});

	it('re-throws a redirect (control flow must propagate)', () => {
		let thrown: unknown;
		try {
			redirect(303, '/login');
		} catch (e) {
			thrown = e;
		}
		expect(() => handleApiError(thrown)).toThrow();
	});
});

describe('withApiErrorHandling — route wrapper', () => {
	// The wrapper's handlers ignore the event entirely, so a bare cast suffices.
	const fakeEvent = {} as Parameters<Parameters<typeof withApiErrorHandling>[0]>[0];

	it('passes a handler response straight through', async () => {
		const ok = new Response('ok', { status: 200 });
		const wrapped = withApiErrorHandling(async () => ok);
		expect(await wrapped(fakeEvent)).toBe(ok);
	});

	it('converts a thrown error into the 500 envelope', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const wrapped = withApiErrorHandling(async () => {
			throw new Error('boom');
		});
		const res = (await wrapped(fakeEvent)) as Response;
		const { status, body } = await read(res);
		expect(status).toBe(500);
		expect(body.error.code).toBe('internal_error');
		spy.mockRestore();
	});

	it('converts a thrown error(404) into the not_found envelope', async () => {
		const wrapped = withApiErrorHandling(async () => {
			error(404, 'missing');
		});
		const res = (await wrapped(fakeEvent)) as Response;
		expect(res.status).toBe(404);
	});
});
