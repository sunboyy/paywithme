import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '$env/dynamic/private';
import * as schema from './schema';

// App-runtime DB client (PLAN §3 "Runtime & driver" / §4 data layer).
//
// We use the `pg` (node-postgres) driver on the Vercel Node runtime — NOT
// `@neondatabase/serverless`, which is edge-only and intentionally unused in v1.
//
// The app connects over Neon's *pooled* connection string (`DATABASE_URL`).
// drizzle-kit migrations use the *direct / non-pooled* string
// (`DATABASE_URL_UNPOOLED`); see `drizzle.config.ts`.
//
// Why `$env/dynamic/private`: it reads the variable at runtime rather than
// inlining it at build time, so `pnpm run build` does NOT fail when
// `DATABASE_URL` is absent (e.g. in CI / the autonomous build). The Pool is
// created lazily on first access for the same reason — importing this module
// during the build must not require a live connection string.

let _pool: Pool | undefined;

function getPool(): Pool {
	if (!_pool) {
		const connectionString = env.DATABASE_URL;
		if (!connectionString) {
			throw new Error(
				"DATABASE_URL is not set. The app needs Neon's pooled connection string at runtime."
			);
		}
		_pool = new Pool({ connectionString });
	}
	return _pool;
}

// `db` is a lazy proxy over the drizzle client: the underlying `pg.Pool` is only
// constructed when a query is actually issued, keeping build/import side-effect
// free while still exporting a fully typed `db`.
type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;

let _db: DrizzleClient | undefined;

function getDb(): DrizzleClient {
	if (!_db) {
		_db = drizzle(getPool(), { schema });
	}
	return _db;
}

export const db = new Proxy({} as DrizzleClient, {
	get(_target, prop, receiver) {
		return Reflect.get(getDb(), prop, receiver);
	}
});
