// Applies pending SQL migrations from ./drizzle. Run with `pnpm db:migrate`.
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must be set');

const client = postgres(url, { max: 1 });
await migrate(drizzle(client), { migrationsFolder: './drizzle' });
await client.end();
console.log('Migrations applied.');
