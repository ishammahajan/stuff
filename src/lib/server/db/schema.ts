import { customType, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { CaptureStatus, Item } from '../../items.ts';

const bytea = customType<{ data: Buffer }>({
	dataType: () => 'bytea'
});

export const sessions = pgTable('sessions', {
	// SHA-256 of the session token, so a database leak doesn't expose usable tokens.
	id: text('id').primaryKey(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull()
});

export const captures = pgTable('captures', {
	id: uuid('id').primaryKey().defaultRandom(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	status: text('status').$type<CaptureStatus>().notNull().default('pending'),
	// WAV recording. Kept until the capture is processed so a failure can be retried.
	audio: bytea('audio'),
	// The speaker's local date and time zone, used to resolve "today" or "tomorrow".
	localDate: text('local_date').notNull(),
	timeZone: text('time_zone').notNull(),
	transcript: text('transcript'),
	items: jsonb('items').$type<Item[]>(),
	error: text('error')
});
