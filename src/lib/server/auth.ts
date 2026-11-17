import { randomUUID } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import {
	decrypt,
	encrypt,
	keyFromSecret,
	keyFromToken,
	randomKey,
	randomRecoveryCode,
	randomSalt,
	randomToken,
	sha256Hex
} from './crypto.ts';
import { db } from './db/index.ts';
import { invites, sessions, users } from './db/schema.ts';

/** A signed-in user and their data key, which decrypts their content. */
export interface Account {
	id: string;
	key: Buffer;
}

export const SESSION_COOKIE = 'session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
export const MIN_PASSWORD_LENGTH = 12;

// Login is by password alone, so a failed attempt names no account, and failures are
// throttled globally. After FREE_ATTEMPTS consecutive failures, each further attempt
// must wait for a delay that doubles up to MAX_DELAY_MS. The state resets on restart.
const FREE_ATTEMPTS = 5;
const MAX_DELAY_MS = 60_000;
let consecutiveFailures = 0;
let lockedUntil = 0;

export type Attempt<T> = { ok: true; value: T } | { ok: false; retryAfterSeconds?: number };

async function throttled<T>(attempt: () => Promise<T | null>): Promise<Attempt<T>> {
	const now = Date.now();
	if (now < lockedUntil) {
		return { ok: false, retryAfterSeconds: Math.ceil((lockedUntil - now) / 1000) };
	}
	const value = await attempt();
	if (value === null) {
		consecutiveFailures += 1;
		if (consecutiveFailures >= FREE_ATTEMPTS) {
			const delay = Math.min(1000 * 2 ** (consecutiveFailures - FREE_ATTEMPTS), MAX_DELAY_MS);
			lockedUntil = Date.now() + delay;
		}
		return { ok: false };
	}
	consecutiveFailures = 0;
	return { ok: true, value };
}

type Secret = 'password' | 'recovery';

/** Finds the account whose data key unwraps with this password or recovery code. */
async function unwrapWith(secret: string, kind: Secret): Promise<Account | null> {
	const rows = await db.select().from(users);
	const found = await Promise.all(
		rows.map(async (row) => {
			const salt = kind === 'password' ? row.passwordSalt : row.recoverySalt;
			const wrapped = kind === 'password' ? row.passwordKey : row.recoveryKey;
			try {
				const key = decrypt(await keyFromSecret(secret, salt), wrapped, `users:${row.id}:${kind}`);
				return { id: row.id, key };
			} catch {
				return null;
			}
		})
	);
	return found.find((account) => account !== null) ?? null;
}

export function signIn(password: string): Promise<Attempt<Account>> {
	return throttled(() => unwrapWith(password, 'password'));
}

export function signInWithRecoveryCode(code: string): Promise<Attempt<Account>> {
	return throttled(() => unwrapWith(code, 'recovery'));
}

/**
 * Checks that no other account uses this password, since the password alone
 * identifies the account. A clash counts as a failed attempt, so the check can't be
 * used to guess passwords faster than signing in.
 */
export function checkPasswordFree(password: string, ownerId?: string): Promise<Attempt<true>> {
	return throttled(async () => {
		const account = await unwrapWith(password, 'password');
		return account === null || account.id === ownerId ? true : null;
	});
}

async function wrapForSecret(id: string, key: Buffer, secret: string, kind: Secret) {
	const salt = randomSalt();
	const wrapped = encrypt(await keyFromSecret(secret, salt), key, `users:${id}:${kind}`);
	return { salt, wrapped };
}

export async function isInviteValid(token: string): Promise<boolean> {
	const rows = await db
		.select({ id: invites.id })
		.from(invites)
		.where(
			and(eq(invites.id, sha256Hex(token)), isNull(invites.usedAt), gt(invites.expiresAt, new Date()))
		)
		.limit(1);
	return rows.length === 1;
}

export interface NewAccount {
	account: Account;
	recoveryCode: string;
}

/** Uses up the invite and creates an account. Returns null if the invite isn't valid. */
export async function createAccount(inviteToken: string, password: string): Promise<NewAccount | null> {
	const id = randomUUID();
	const key = randomKey();
	const recoveryCode = randomRecoveryCode();
	const [byPassword, byRecovery] = await Promise.all([
		wrapForSecret(id, key, password, 'password'),
		wrapForSecret(id, key, recoveryCode, 'recovery')
	]);

	return db.transaction(async (tx) => {
		const [invite] = await tx
			.update(invites)
			.set({ usedAt: new Date() })
			.where(
				and(
					eq(invites.id, sha256Hex(inviteToken)),
					isNull(invites.usedAt),
					gt(invites.expiresAt, new Date())
				)
			)
			.returning({ id: invites.id });
		if (!invite) return null;

		await tx.insert(users).values({
			id,
			passwordSalt: byPassword.salt,
			passwordKey: byPassword.wrapped,
			recoverySalt: byRecovery.salt,
			recoveryKey: byRecovery.wrapped
		});
		return { account: { id, key }, recoveryCode };
	});
}

/** Replaces the password and signs the account out everywhere. */
export async function setPassword(account: Account, password: string): Promise<void> {
	const { salt, wrapped } = await wrapForSecret(account.id, account.key, password, 'password');
	await db.transaction(async (tx) => {
		await tx
			.update(users)
			.set({ passwordSalt: salt, passwordKey: wrapped })
			.where(eq(users.id, account.id));
		await tx.delete(sessions).where(eq(sessions.userId, account.id));
	});
}

export async function createSession(account: Account): Promise<string> {
	const token = randomToken();
	const id = sha256Hex(token);
	const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
	await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
	await db.insert(sessions).values({
		id,
		userId: account.id,
		expiresAt,
		key: encrypt(keyFromToken(token), account.key, `sessions:${id}:key`)
	});
	return token;
}

export async function getSessionAccount(token: string): Promise<Account | null> {
	const id = sha256Hex(token);
	const [row] = await db
		.select({ userId: sessions.userId, key: sessions.key })
		.from(sessions)
		.where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
		.limit(1);
	if (!row) return null;
	try {
		return { id: row.userId, key: decrypt(keyFromToken(token), row.key, `sessions:${id}:key`) };
	} catch {
		return null;
	}
}

export async function deleteSession(token: string): Promise<void> {
	await db.delete(sessions).where(eq(sessions.id, sha256Hex(token)));
}

export function setSessionCookie(cookies: Cookies, token: string): void {
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: SESSION_MAX_AGE_SECONDS
	});
}

/** Returns a message if the password can't be used, or null if it's fine. */
export function passwordProblem(password: string, confirmation: string): string | null {
	if (password.length < MIN_PASSWORD_LENGTH) {
		return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
	}
	if (password !== confirmation) return "The passwords don't match.";
	return null;
}
