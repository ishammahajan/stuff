// Task reminders as an iCalendar subscription, so the phone's Calendar raises the
// alarms. Apple fetches the feed while the user is away, when nothing can unlock
// their data key, so each change to the records rewrites a ready-made copy that
// only the link's token can read. See `calendarFeeds` in the schema.
import { eq } from 'drizzle-orm';
import type { Account } from './auth.ts';
import { decrypt, encrypt, keyFromToken, randomKey, randomToken, sha256Hex } from './crypto.ts';
import { db } from './db/index.ts';
import { calendarFeeds } from './db/schema.ts';
import { loadRecords, type StoredRecord } from './records.ts';

// A dated task without a reminder time rings at this local hour on its date.
export const DUE_HOUR = 9;
// How long each reminder's event lasts in the calendar.
const EVENT_MINUTES = 15;
const TOKEN_PURPOSE = 'stuff calendar key';

const accountKeyContext = (userId: string) => `calendar_feeds:${userId}:account-key`;
const tokenKeyContext = (userId: string) => `calendar_feeds:${userId}:token-key`;
const bodyContext = (userId: string) => `calendar_feeds:${userId}:body`;

/** Escapes text for an iCalendar property value. */
function escapeText(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Folds a content line to at most 75 bytes per line, as iCalendar requires. */
function fold(line: string): string {
	const parts: string[] = [];
	let current = '';
	let bytes = 0;
	for (const char of line) {
		const size = Buffer.byteLength(char);
		// Continuation lines start with a space, which counts toward their 75 bytes.
		if (bytes + size > (parts.length === 0 ? 75 : 74)) {
			parts.push(current);
			current = '';
			bytes = 0;
		}
		current += char;
		bytes += size;
	}
	parts.push(current);
	return parts.join('\r\n ');
}

/** YYYY-MM-DDTHH:MM to a floating local iCalendar time, such as 20261120T150000. */
function floating(local: string): string {
	return `${local.replace(/[-:]/g, '')}00`;
}

/** When a task rings, as local wall time, or null when it has no date. */
export function reminderTime(task: { date: string | null; remindAt: string | null }): string | null {
	if (task.remindAt) return task.remindAt;
	if (task.date) return `${task.date}T${String(DUE_HOUR).padStart(2, '0')}:00`;
	return null;
}

/**
 * Builds the calendar: one event with an alarm per open task that has a reminder
 * time or a date. Times are floating, so they ring at that wall time wherever the
 * phone is.
 */
export function buildCalendar(records: StoredRecord[], now = new Date()): string {
	const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Stuff//Task reminders//EN',
		'CALSCALE:GREGORIAN',
		'METHOD:PUBLISH',
		'X-WR-CALNAME:Stuff tasks',
		'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
		'X-PUBLISHED-TTL:PT15M'
	];
	for (const record of records) {
		if (record.type !== 'task' || record.completedAt) continue;
		const time = reminderTime(record.fields);
		if (!time) continue;
		const title = escapeText(record.fields.title);
		lines.push(
			'BEGIN:VEVENT',
			`UID:${record.id}@stuff`,
			`DTSTAMP:${stamp}`,
			`DTSTART:${floating(time)}`,
			`DURATION:PT${EVENT_MINUTES}M`,
			`SUMMARY:${title}`,
			...(record.fields.details ? [`DESCRIPTION:${escapeText(record.fields.details)}`] : []),
			'BEGIN:VALARM',
			'ACTION:DISPLAY',
			`DESCRIPTION:${title}`,
			'TRIGGER:PT0S',
			'END:VALARM',
			'END:VEVENT'
		);
	}
	lines.push('END:VCALENDAR');
	return lines.map(fold).join('\r\n') + '\r\n';
}

export async function hasFeed(account: Account): Promise<boolean> {
	const [row] = await db
		.select({ userId: calendarFeeds.userId })
		.from(calendarFeeds)
		.where(eq(calendarFeeds.userId, account.id))
		.limit(1);
	return Boolean(row);
}

/**
 * Creates the account's calendar link, replacing any earlier one, which stops
 * working. Returns the token, which is only ever in the link.
 */
export async function createFeed(account: Account): Promise<string> {
	const token = randomToken();
	const feedKey = randomKey();
	const ics = buildCalendar(await loadRecords(account));
	const values = {
		tokenHash: sha256Hex(token),
		createdAt: new Date(),
		updatedAt: new Date(),
		keyByAccount: encrypt(account.key, feedKey, accountKeyContext(account.id)),
		keyByToken: encrypt(keyFromToken(token, TOKEN_PURPOSE), feedKey, tokenKeyContext(account.id)),
		body: encrypt(feedKey, Buffer.from(ics, 'utf8'), bodyContext(account.id))
	};
	await db
		.insert(calendarFeeds)
		.values({ userId: account.id, ...values })
		.onConflictDoUpdate({ target: calendarFeeds.userId, set: values });
	return token;
}

export async function deleteFeed(account: Account): Promise<void> {
	await db.delete(calendarFeeds).where(eq(calendarFeeds.userId, account.id));
}

/** Rewrites the feed's copy of the reminders, if the account has a feed. */
export async function refreshFeed(account: Account): Promise<void> {
	const [row] = await db
		.select({ keyByAccount: calendarFeeds.keyByAccount })
		.from(calendarFeeds)
		.where(eq(calendarFeeds.userId, account.id))
		.limit(1);
	if (!row) return;
	const feedKey = decrypt(account.key, row.keyByAccount, accountKeyContext(account.id));
	const ics = buildCalendar(await loadRecords(account));
	await db
		.update(calendarFeeds)
		.set({
			updatedAt: new Date(),
			body: encrypt(feedKey, Buffer.from(ics, 'utf8'), bodyContext(account.id))
		})
		.where(eq(calendarFeeds.userId, account.id));
}

/** Refreshes the feed after a change, logging instead of failing the request. */
export function refreshFeedQuietly(account: Account): Promise<void> {
	return refreshFeed(account).catch((error) =>
		console.error(`Calendar feed for ${account.id} failed to refresh:`, error)
	);
}

/** Returns the calendar text for a link's token, or null when no feed has it. */
export async function readFeed(token: string): Promise<string | null> {
	const [row] = await db
		.select()
		.from(calendarFeeds)
		.where(eq(calendarFeeds.tokenHash, sha256Hex(token)))
		.limit(1);
	if (!row) return null;
	const feedKey = decrypt(keyFromToken(token, TOKEN_PURPOSE), row.keyByToken, tokenKeyContext(row.userId));
	return decrypt(feedKey, row.body, bodyContext(row.userId)).toString('utf8');
}
