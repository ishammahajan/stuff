// Creates a one-time invite link for a new account. Run with `pnpm invite`.
//
// The invitee opens the link and chooses their own password, so whoever runs this
// script never learns it. Links expire after seven days.
//
// Options:
//   --owner         The new account takes over captures made before accounts existed.
//   --origin <url>  The site's URL for the link. Defaults to the ORIGIN variable.
import { parseArgs } from 'node:util';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { randomToken, sha256Hex } from '../src/lib/server/crypto.ts';
import { invites } from '../src/lib/server/db/schema.ts';

const INVITE_DAYS = 7;

const { values } = parseArgs({
	options: {
		owner: { type: 'boolean', default: false },
		origin: { type: 'string' }
	}
});

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must be set');
const origin = values.origin ?? process.env.ORIGIN;
if (!origin) throw new Error('Pass --origin or set ORIGIN to the site URL');

const client = postgres(url, { max: 1 });
const token = randomToken();
await drizzle(client)
	.insert(invites)
	.values({
		id: sha256Hex(token),
		expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000),
		adoptUnowned: values.owner
	});
await client.end();

console.log(`${new URL(`/join/${token}`, origin)}`);
