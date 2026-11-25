// Per-user settings, stored encrypted on the user's row.
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Budget, Category } from '../items.ts';
import type { Account } from './auth.ts';
import { decryptJson, encryptJson } from './crypto.ts';
import { db } from './db/index.ts';
import { users } from './db/schema.ts';

export interface Settings {
	/** Proper nouns the user says, spelled the way they want them written. */
	names: string[];
	budget: Budget;
}

export const MAX_NAMES = 200;
export const MAX_NAME_LENGTH = 60;
export const MAX_CATEGORIES = 30;
export const MAX_CATEGORY_LENGTH = 40;
// Large enough for any personal amount, small enough to stay exact as a number.
export const MAX_AMOUNT = 1e12;

const DEFAULTS: Settings = {
	names: [],
	budget: {
		categories: [],
		monthlyIncome: null,
		currency: 'INR',
		rules: [],
		balances: { savings: null, card: null }
	}
};

/** A new category ID: short, random, and stable across renames. */
export const newCategoryId = () => randomBytes(4).toString('hex');

/** A category with these fields, or null when one is malformed. */
export function cleanCategory(id: unknown, name: unknown, monthly: unknown): Category | null {
	if (typeof id !== 'string' || !/^[0-9a-f]{8}$/.test(id)) return null;
	const cleaned = typeof name === 'string' ? cleanName(name, MAX_CATEGORY_LENGTH) : null;
	const amount = cleanAmount(monthly);
	if (!cleaned || amount === null) return null;
	return { id, name: cleaned, monthly: amount };
}

/** A non-negative amount rounded to paise or cents, or null when it isn't one. */
export function cleanAmount(input: unknown): number | null {
	const value = typeof input === 'string' ? Number(input.replace(/[,\s]/g, '')) : input;
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_AMOUNT) {
		return null;
	}
	return Math.round(value * 100) / 100;
}

const settingsContext = (userId: string) => `users:${userId}:settings`;

export async function loadSettings(account: Account): Promise<Settings> {
	const [row] = await db
		.select({ settings: users.settings })
		.from(users)
		.where(eq(users.id, account.id));
	if (!row?.settings) return structuredClone(DEFAULTS);
	const stored = decryptJson<Partial<Settings>>(
		account.key,
		row.settings,
		settingsContext(account.id)
	);
	const defaults = structuredClone(DEFAULTS);
	// Fills budget fields that settings saved before they existed lack.
	return { ...defaults, ...stored, budget: { ...defaults.budget, ...stored.budget } };
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
export function cleanName(input: string, maxLength = MAX_NAME_LENGTH): string | null {
	const name = input.replace(/\s+/g, ' ').trim();
	if (!name || name.length > maxLength) return null;
	return name;
}
