import { describe, it, expect } from 'vitest';
import {
	JSON_RPC_ERROR_CODES,
	JSON_RPC_VERSION,
	jsonRpcError,
	jsonRpcErrorObject,
	jsonRpcResult,
	parseJsonRpcMessage
} from './jsonrpc';

describe('parseJsonRpcMessage', () => {
	it('parses a request (an `id` is present → it expects a response)', () => {
		const parsed = parseJsonRpcMessage({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'list_groups' }
		});

		expect(parsed).toEqual({
			kind: 'request',
			request: { id: 1, method: 'tools/call', params: { name: 'list_groups' } }
		});
	});

	it('accepts a string id', () => {
		const parsed = parseJsonRpcMessage({ jsonrpc: '2.0', id: 'abc', method: 'ping' });
		expect(parsed).toEqual({ kind: 'request', request: { id: 'abc', method: 'ping', params: {} } });
	});

	it('defaults absent params to an empty object', () => {
		const parsed = parseJsonRpcMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		expect(parsed).toMatchObject({ kind: 'request', request: { params: {} } });
	});

	it('parses a NOTIFICATION (no `id` → it must never be answered)', () => {
		const parsed = parseJsonRpcMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });

		expect(parsed).toEqual({
			kind: 'notification',
			notification: { method: 'notifications/initialized', params: {} }
		});
	});

	it('rejects a BATCH — arrays were removed from the spec in 2025-06-18', () => {
		const parsed = parseJsonRpcMessage([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);

		expect(parsed.kind).toBe('invalid');
		if (parsed.kind !== 'invalid') throw new Error('expected invalid');
		expect(parsed.error.code).toBe(JSON_RPC_ERROR_CODES.invalid_request);
		expect(parsed.error.message).toMatch(/batching is not supported/i);
	});

	it.each([
		['a wrong jsonrpc version', { jsonrpc: '1.0', id: 1, method: 'ping' }],
		['a missing jsonrpc field', { id: 1, method: 'ping' }],
		['a missing method', { jsonrpc: '2.0', id: 1 }],
		['an empty method', { jsonrpc: '2.0', id: 1, method: '' }],
		['a non-string method', { jsonrpc: '2.0', id: 1, method: 42 }],
		// `null` is a legal JSON-RPC id but MCP forbids it — and it is
		// indistinguishable from a notification, so it can never be honoured.
		['a null id', { jsonrpc: '2.0', id: null, method: 'ping' }],
		['a string body', 'ping'],
		['null', null]
	])('rejects %s as invalid_request', (_label, payload) => {
		const parsed = parseJsonRpcMessage(payload);

		expect(parsed.kind).toBe('invalid');
		if (parsed.kind !== 'invalid') throw new Error('expected invalid');
		expect(parsed.error.code).toBe(JSON_RPC_ERROR_CODES.invalid_request);
	});
});

describe('response builders', () => {
	it('builds a success response echoing the id', () => {
		expect(jsonRpcResult(7, { ok: true })).toEqual({
			jsonrpc: JSON_RPC_VERSION,
			id: 7,
			result: { ok: true }
		});
	});

	it('builds an error response echoing the id', () => {
		const error = jsonRpcErrorObject(JSON_RPC_ERROR_CODES.method_not_found, 'Unknown method: nope');
		expect(jsonRpcError('x', error)).toEqual({
			jsonrpc: JSON_RPC_VERSION,
			id: 'x',
			error: { code: -32601, message: 'Unknown method: nope' }
		});
	});

	it('omits `data` when none is given, and includes it when there is', () => {
		expect(jsonRpcErrorObject(-32600, 'bad')).not.toHaveProperty('data');
		expect(jsonRpcErrorObject(-32600, 'bad', { why: 'x' }).data).toEqual({ why: 'x' });
	});
});
