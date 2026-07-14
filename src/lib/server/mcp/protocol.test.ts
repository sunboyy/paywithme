import { describe, it, expect } from 'vitest';
import {
	MCP_PROTOCOL_VERSION,
	MCP_SERVER_INFO,
	initializeResult,
	negotiateProtocolVersion
} from './protocol';

describe('negotiateProtocolVersion', () => {
	it('echoes a version we support', () => {
		expect(negotiateProtocolVersion('2025-06-18')).toBe('2025-06-18');
		expect(negotiateProtocolVersion('2025-03-26')).toBe('2025-03-26');
	});

	it('falls back to our latest for an unsupported / missing / garbage version', () => {
		expect(negotiateProtocolVersion('2024-11-05')).toBe(MCP_PROTOCOL_VERSION);
		expect(negotiateProtocolVersion(undefined)).toBe(MCP_PROTOCOL_VERSION);
		expect(negotiateProtocolVersion(42)).toBe(MCP_PROTOCOL_VERSION);
	});
});

describe('initializeResult', () => {
	it('advertises the tools capability and our identity', () => {
		const result = initializeResult({ protocolVersion: '2025-06-18' });

		expect(result).toMatchObject({
			protocolVersion: '2025-06-18',
			capabilities: { tools: { listChanged: false } },
			serverInfo: MCP_SERVER_INFO
		});
		expect(result.instructions).toContain('MINOR units');
	});

	it('carries NO session id — the server is stateless (ADR-0001)', () => {
		const result = initializeResult({}) as unknown as Record<string, unknown>;
		expect(result.sessionId).toBeUndefined();
		expect(Object.keys(result)).toEqual([
			'protocolVersion',
			'capabilities',
			'serverInfo',
			'instructions'
		]);
	});
});
