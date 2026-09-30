import { describe, it, expect } from 'vitest';
import { getTableName, getTableColumns } from 'drizzle-orm';
import {
	jwks,
	oauthClient,
	oauthResource,
	oauthClientResource,
	oauthRefreshToken,
	oauthAccessToken,
	oauthConsent,
	oauthClientAssertion
} from './oauth-schema';
import * as schema from './schema';

// Import-level shape assertions for the hand-authored Drizzle tables backing the
// connector OAuth server (`@better-auth/mcp` on `@better-auth/oauth-provider`,
// plus the `jwt` plugin's key table — ADR-0018). No DB connection: we inspect the
// table objects directly so an accidental rename/retype of a column, which would
// silently break the plugin's store, is caught at unit time. Model and field
// names are the plugins' own contract.

/** Every table, under the model name the drizzle adapter resolves it by. */
const TABLES = {
	jwks: [jwks, 'jwks'],
	oauthClient: [oauthClient, 'oauth_client'],
	oauthResource: [oauthResource, 'oauth_resource'],
	oauthClientResource: [oauthClientResource, 'oauth_client_resource'],
	oauthRefreshToken: [oauthRefreshToken, 'oauth_refresh_token'],
	oauthAccessToken: [oauthAccessToken, 'oauth_access_token'],
	oauthConsent: [oauthConsent, 'oauth_consent'],
	oauthClientAssertion: [oauthClientAssertion, 'oauth_client_assertion']
} as const;

describe.each(Object.entries(TABLES))('%s drizzle table', (modelName, [table, sqlName]) => {
	it(`maps to the singular \`${sqlName}\` SQL table`, () => {
		// `usePlural` is off in our adapter, so the SQL name stays singular.
		expect(getTableName(table)).toBe(sqlName);
	});

	it('is re-exported from the schema entry point under its model name', () => {
		// The drizzle adapter resolves the plugin model via `schema[modelName]`, so
		// this exact key MUST be in the schema passed to `drizzle(pool, { schema })`
		// and to drizzle-kit.
		expect((schema as Record<string, unknown>)[modelName]).toBe(table);
	});
});

describe('the old oidc-provider tables are gone', () => {
	it('no longer exports `oauthApplication`', () => {
		// Replaced by `oauthClient`. A stale export would give drizzle-kit a table to
		// recreate and the adapter a model nothing uses.
		expect((schema as Record<string, unknown>).oauthApplication).toBeUndefined();
	});
});

describe('jwks', () => {
	it('stores the key pair as required text', () => {
		const columns = getTableColumns(jwks);
		expect(Object.keys(columns).sort()).toEqual(
			['id', 'publicKey', 'privateKey', 'createdAt', 'expiresAt', 'alg', 'crv'].sort()
		);
		expect(columns.publicKey.notNull).toBe(true);
		expect(columns.privateKey.notNull).toBe(true);
		expect(columns.expiresAt.notNull).toBe(false);
	});
});

describe('oauthClient', () => {
	it('makes clientId a required, unique lookup column', () => {
		const columns = getTableColumns(oauthClient);
		expect(columns.clientId.name).toBe('client_id');
		expect(columns.clientId.notNull).toBe(true);
		// It is the FK target for the token / consent tables, so it must be unique.
		expect(columns.clientId.isUnique).toBe(true);
	});

	it('stores redirect URIs and scopes as native text arrays', () => {
		const columns = getTableColumns(oauthClient);
		// `string[]` fields: the pg adapter reports `supportsArrays`.
		expect(columns.redirectUris.columnType).toBe('PgArray');
		expect(columns.redirectUris.notNull).toBe(true);
		expect(columns.scopes.columnType).toBe('PgArray');
		expect(columns.scopes.notNull).toBe(false);
	});

	it('stores metadata as jsonb', () => {
		expect(getTableColumns(oauthClient).metadata.columnType).toBe('PgJsonb');
	});

	it('defaults disabled to false, nullable per the plugin', () => {
		const columns = getTableColumns(oauthClient);
		expect(columns.disabled.columnType).toBe('PgBoolean');
		expect(columns.disabled.default).toBe(false);
		expect(columns.disabled.notNull).toBe(false);
	});
});

describe('oauthResource', () => {
	it('keys resources by a unique identifier (the `/mcp` URL)', () => {
		const columns = getTableColumns(oauthResource);
		expect(columns.identifier.notNull).toBe(true);
		expect(columns.identifier.isUnique).toBe(true);
		expect(columns.name.notNull).toBe(true);
	});
});

describe('oauthRefreshToken', () => {
	it('has a required, unique token and a required user', () => {
		const columns = getTableColumns(oauthRefreshToken);
		expect(columns.token.notNull).toBe(true);
		expect(columns.token.isUnique).toBe(true);
		expect(columns.userId.notNull).toBe(true);
		expect(columns.clientId.notNull).toBe(true);
		expect(columns.scopes.columnType).toBe('PgArray');
		expect(columns.scopes.notNull).toBe(true);
	});

	it('carries the rotation-replay columns the MCP refresh overlap needs', () => {
		const columns = getTableColumns(oauthRefreshToken);
		for (const key of ['rotatedAt', 'rotationReplayResponse', 'rotationReplayExpiresAt'] as const) {
			expect(columns[key].notNull).toBe(false);
		}
	});
});

describe('oauthAccessToken', () => {
	it('has a required, unique token; userId is optional (client-credentials tokens)', () => {
		const columns = getTableColumns(oauthAccessToken);
		expect(columns.token.notNull).toBe(true);
		expect(columns.token.isUnique).toBe(true);
		expect(columns.clientId.notNull).toBe(true);
		expect(columns.userId.notNull).toBe(false);
		expect(columns.scopes.columnType).toBe('PgArray');
	});
});

describe('oauthConsent', () => {
	it('records granted scopes as a required array per client', () => {
		const columns = getTableColumns(oauthConsent);
		expect(Object.keys(columns).sort()).toEqual(
			[
				'id',
				'clientId',
				'userId',
				'referenceId',
				'resources',
				'requestedUserInfoClaims',
				'scopes',
				'createdAt',
				'updatedAt'
			].sort()
		);
		expect(columns.clientId.notNull).toBe(true);
		expect(columns.scopes.columnType).toBe('PgArray');
		expect(columns.scopes.notNull).toBe(true);
	});
});
