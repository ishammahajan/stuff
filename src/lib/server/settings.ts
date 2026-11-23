// Per-user settings, stored encrypted on the user's row.
import { eq } from 'drizzle-orm';
import type { Account } from './auth.ts';
import { decryptJson, encryptJson } from './crypto.ts';
import { db } from './db/index.ts';
import { users } from './db/schema.ts';

export interface Settings {
	/** Proper nouns the user says, spelled the way they want them written. */
	names: string[];
}

export const MAX_NAMES = 200;
export const MAX_NAME_LENGTH = 60;

const DEFAULTS: Settings = { names: [] };

const settingsContext = (userId: string) => `users:${userId}:settings`;

export async function loadSettings(account: Account): Promise<Settings> {
	const [row] = await db
		.select({ settings: users.settings })
		.from(users)
		.where(eq(users.id, account.id));
	if (!row?.settings) return { ...DEFAULTS };
	const stored = decryptJson<Partial<Settings>>(account.key, row.settings, settingsContext(account.id));
	return { ...DEFAULTS, ...stored };
}

export async function saveSettings(account: Account, settings: Settings): Promise<void> {
	await db
		.update(users)
		.set({ settings: encryptJson(account.key, settings, settingsContext(account.id)) })
		.where(eq(users.id, account.id));
}

/**
 * Cleans a name typed by the user: trims and collapses spaces. Returns null when
 * nothing is left or it is too long.
 */
export function cleanName(input: string): string | null {
	const name = input.replace(/\s+/g, ' ').trim();
	if (!name || name.length > MAX_NAME_LENGTH) return null;
	return name;
}
