import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const sessions = pgTable('sessions', {
	// SHA-256 of the session token, so a database leak doesn't expose usable tokens.
	id: text('id').primaryKey(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull()
});
