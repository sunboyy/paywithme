import { describe, it, expect } from 'vitest';
import { getTableName, getTableColumns } from 'drizzle-orm';
import { oauthApplication, oauthAccessToken, oauthConsent } from './oauth-schema';
import * as schema from './schema';

// Import-level shape assertions for the hand-authored Drizzle tables backing
// better-auth's `mcp` OAuth authorization server (ADR-0010). No DB connection:
// we inspect the table objects directly so an accidental rename/retype of a
// column — which would silently break the plugin's store — is caught at unit
// time. The `mcp` plugin reuses the `oidcProvider` plugin's `schema`, so the
// three model names / field names asserted here are that plugin's own contract.

describe('oauthApplication drizzle table', () => {
	it('maps to the singular `oauth_application` SQL table', () => {
		// `usePlural` is off in our adapter, so the SQL name stays singular.
		expect(getTableName(oauthApplication)).toBe('oauth_application');
	});

	it('exports exactly the columns the plugin `oauthApplication` model expects', () => {
		const columns = getTableColumns(oauthApplication);
		// Property keys (camelCase) are the better-auth field names the drizzle
		// adapter resolves via `schemaModel[fieldName]`.
		expect(Object.keys(columns).sort()).toEqual(
			[
				'id',
				'name',
				'icon',
				'metadata',
				'clientId',
				'clientSecret',
				'redirectUrls',
				'type',
				'disabled',
				'userId',
				'createdAt',
				'updatedAt'
			].sort()
		);
	});

	it('makes clientId a required, unique lookup column', () => {
		const columns = getTableColumns(oauthApplication);
		expect(columns.clientId.name).toBe('client_id');
		expect(columns.clientId.notNull).toBe(true);
		// It is the FK target for the token / consent tables, so it must be unique.
		expect(columns.clientId.isUnique).toBe(true);
	});

	it('marks name / redirectUrls / type as required, and icon / metadata / clientSecret as optional', () => {
		const columns = getTableColumns(oauthApplication);
		// required !== false ⇒ notNull (mirrors the plugin's own generator rule).
		expect(columns.name.notNull).toBe(true);
		expect(columns.redirectUrls.notNull).toBe(true);
		expect(columns.type.notNull).toBe(true);
		// required: false ⇒ nullable.
		expect(columns.icon.notNull).toBe(false);
		expect(columns.metadata.notNull).toBe(false);
		expect(columns.clientSecret.notNull).toBe(false);
	});

	it('gives disabled a boolean column defaulting to false, nullable per the plugin', () => {
		const columns = getTableColumns(oauthApplication);
		expect(columns.disabled.columnType).toBe('PgBoolean');
		expect(columns.disabled.default).toBe(false);
		expect(columns.disabled.notNull).toBe(false);
	});

	it('maps date fields to timestamp columns', () => {
		const columns = getTableColumns(oauthApplication);
		for (const key of ['createdAt', 'updatedAt'] as const) {
			expect(columns[key].columnType).toBe('PgTimestamp');
		}
	});

	it('is re-exported from the schema entry point under the `oauthApplication` key', () => {
		// The drizzle adapter resolves the plugin's `oauthApplication` model via
		// `schema['oauthApplication']`, so this exact key MUST be present in the
		// schema object passed to `drizzle(pool, { schema })` and to drizzle-kit.
		expect((schema as Record<string, unknown>).oauthApplication).toBe(oauthApplication);
	});
});

describe('oauthAccessToken drizzle table', () => {
	it('maps to the singular `oauth_access_token` SQL table', () => {
		expect(getTableName(oauthAccessToken)).toBe('oauth_access_token');
	});

	it('exports exactly the columns the plugin `oauthAccessToken` model expects', () => {
		const columns = getTableColumns(oauthAccessToken);
		expect(Object.keys(columns).sort()).toEqual(
			[
				'id',
				'accessToken',
				'refreshToken',
				'accessTokenExpiresAt',
				'refreshTokenExpiresAt',
				'clientId',
				'userId',
				'scopes',
				'createdAt',
				'updatedAt'
			].sort()
		);
	});

	it('makes accessToken and refreshToken required, unique lookup columns', () => {
		const columns = getTableColumns(oauthAccessToken);
		expect(columns.accessToken.name).toBe('access_token');
		expect(columns.accessToken.notNull).toBe(true);
		expect(columns.accessToken.isUnique).toBe(true);
		expect(columns.refreshToken.name).toBe('refresh_token');
		expect(columns.refreshToken.notNull).toBe(true);
		expect(columns.refreshToken.isUnique).toBe(true);
	});

	it('requires clientId but leaves userId optional (per the plugin spec)', () => {
		const columns = getTableColumns(oauthAccessToken);
		expect(columns.clientId.notNull).toBe(true);
		// userId is `required: false` in the oidc schema.
		expect(columns.userId.notNull).toBe(false);
	});

	it('maps the four date fields to timestamp columns', () => {
		const columns = getTableColumns(oauthAccessToken);
		for (const key of [
			'accessTokenExpiresAt',
			'refreshTokenExpiresAt',
			'createdAt',
			'updatedAt'
		] as const) {
			expect(columns[key].columnType).toBe('PgTimestamp');
		}
	});

	it('is re-exported from the schema entry point under the `oauthAccessToken` key', () => {
		expect((schema as Record<string, unknown>).oauthAccessToken).toBe(oauthAccessToken);
	});
});

describe('oauthConsent drizzle table', () => {
	it('maps to the singular `oauth_consent` SQL table', () => {
		expect(getTableName(oauthConsent)).toBe('oauth_consent');
	});

	it('exports exactly the columns the plugin `oauthConsent` model expects', () => {
		const columns = getTableColumns(oauthConsent);
		expect(Object.keys(columns).sort()).toEqual(
			['id', 'clientId', 'userId', 'scopes', 'createdAt', 'updatedAt', 'consentGiven'].sort()
		);
	});

	it('requires clientId, userId, scopes, and the consentGiven flag', () => {
		const columns = getTableColumns(oauthConsent);
		expect(columns.clientId.notNull).toBe(true);
		// Unlike the token table, consent's userId is required in the oidc schema.
		expect(columns.userId.notNull).toBe(true);
		expect(columns.scopes.notNull).toBe(true);
		expect(columns.consentGiven.name).toBe('consent_given');
		expect(columns.consentGiven.columnType).toBe('PgBoolean');
		expect(columns.consentGiven.notNull).toBe(true);
	});

	it('is re-exported from the schema entry point under the `oauthConsent` key', () => {
		expect((schema as Record<string, unknown>).oauthConsent).toBe(oauthConsent);
	});
});
