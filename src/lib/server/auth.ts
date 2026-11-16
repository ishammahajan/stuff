import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import { APP_PASSWORD_HASH } from '$app/env/private';
import { db } from './db/index.ts';
import { sessions } from './db/schema.ts';
import { verifyPassword } from './password.ts';

export const SESSION_COOKIE = 'session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

// The app has one user, so failed logins are throttled globally. After
// FREE_ATTEMPTS consecutive failures, each further attempt must wait for a
// delay that doubles up to MAX_DELAY_MS. The state resets on restart.
const FREE_ATTEMPTS = 5;
const MAX_DELAY_MS = 60_000;
let consecutiveFailures = 0;
let lockedUntil = 0;

export type LoginResult = { ok: true; token: string } | { ok: false; retryAfterSeconds?: number };

function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export async function login(password: string): Promise<LoginResult> {
	const now = Date.now();
	if (now < lockedUntil) {
		return { ok: false, retryAfterSeconds: Math.ceil((lockedUntil - now) / 1000) };
	}

	if (!(await verifyPassword(password, APP_PASSWORD_HASH))) {
		consecutiveFailures += 1;
		if (consecutiveFailures >= FREE_ATTEMPTS) {
			const delay = Math.min(1000 * 2 ** (consecutiveFailures - FREE_ATTEMPTS), MAX_DELAY_MS);
			lockedUntil = Date.now() + delay;
		}
		return { ok: false };
	}

	consecutiveFailures = 0;
	const token = randomBytes(32).toString('base64url');
	const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
	await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
	await db.insert(sessions).values({ id: hashToken(token), expiresAt });
	return { ok: true, token };
}

export async function isValidSession(token: string): Promise<boolean> {
	const rows = await db
		.select({ id: sessions.id })
		.from(sessions)
		.where(and(eq(sessions.id, hashToken(token)), gt(sessions.expiresAt, new Date())))
		.limit(1);
	return rows.length === 1;
}

export async function logout(token: string): Promise<void> {
	await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}
