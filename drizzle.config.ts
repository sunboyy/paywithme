import { defineConfig } from 'drizzle-kit';

// drizzle-kit configuration (migrations / generate / push / studio).
//
// IMPORTANT: drizzle-kit must use Neon's *direct / non-pooled* connection
// string (`DATABASE_URL_UNPOOLED`), not the pooled URL the app uses at runtime
// (`DATABASE_URL`). Pooled connections (PgBouncer in transaction mode) do not
// support the session-level features migrations rely on. See PLAN §3
// "Runtime & driver".
//
// Env var names (also documented in `.env.example`, task 1.6):
//   DATABASE_URL          — pooled URL, used by the app at runtime (src/lib/server/db)
//   DATABASE_URL_UNPOOLED — direct URL, used by drizzle-kit migrations (here)

export default defineConfig({
	dialect: 'postgresql',
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	dbCredentials: {
		url: process.env.DATABASE_URL_UNPOOLED ?? ''
	}
});
