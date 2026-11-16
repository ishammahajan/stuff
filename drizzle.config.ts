import { defineConfig } from 'drizzle-kit';

// Used only to generate SQL migrations from the schema (`pnpm db:generate`).
// Migrations are applied by scripts/migrate.ts.
export default defineConfig({
	dialect: 'postgresql',
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle'
});
