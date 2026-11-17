import { boolean, customType, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { CaptureStatus, Item } from '../../items.ts';

const bytea = customType<{ data: Buffer }>({
	dataType: () => 'bytea'
});

// Encrypted columns hold the output of `encrypt` in `src/lib/server/crypto.ts`.
// Each one notes the context string it was encrypted with.

export const users = pgTable('users', {
	// Set by the app, because the ID is part of the encryption context.
	id: uuid('id').primaryKey(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	// The user's data key, wrapped by a key derived from the password and salt.
	// Context: `users:<id>:password`.
	passwordSalt: bytea('password_salt').notNull(),
	passwordKey: bytea('password_key').notNull(),
	// The same data key, wrapped by a key derived from the recovery code.
	// Context: `users:<id>:recovery`.
	recoverySalt: bytea('recovery_salt').notNull(),
	recoveryKey: bytea('recovery_key').notNull()
});

export const invites = pgTable('invites', {
	// SHA-256 of the invite token, which is only ever in the invite link.
	id: text('id').primaryKey(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	usedAt: timestamp('used_at', { withTimezone: true }),
	// Whether the new account takes over captures from before accounts existed.
	adoptUnowned: boolean('adopt_unowned').notNull().default(false)
});

export const sessions = pgTable('sessions', {
	// SHA-256 of the session token, so a database leak doesn't expose usable tokens.
	id: text('id').primaryKey(),
	userId: uuid('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	// The user's data key, wrapped by a key derived from the session token.
	// Context: `sessions:<id>:key`.
	key: bytea('key').notNull()
});

export const captures = pgTable(
	'captures',
	{
		// Set by the app, because the ID is part of the encryption context.
		id: uuid('id').primaryKey(),
		// Null only for captures from before accounts existed, until they are adopted.
		userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		status: text('status').$type<CaptureStatus>().notNull().default('pending'),
		// Encrypted WAV recording, kept until processing succeeds so a failure can be
		// retried. Context: `captures:<id>:audio`.
		audio: bytea('audio'),
		// Encrypted `CaptureBody` JSON. Context: `captures:<id>:body`.
		body: bytea('body'),

		// Plaintext columns from before accounts existed. Adoption moves their content
		// into `body` and clears them. Drop them once no unowned captures remain.
		localDate: text('local_date'),
		timeZone: text('time_zone'),
		transcript: text('transcript'),
		items: jsonb('items').$type<Item[]>(),
		error: text('error')
	},
	(table) => [index('captures_user_created_idx').on(table.userId, table.createdAt)]
);
