import { customType, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { CaptureStatus } from '../../items.ts';

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
	usedAt: timestamp('used_at', { withTimezone: true })
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
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		status: text('status').$type<CaptureStatus>().notNull().default('pending'),
		// Encrypted WAV recording, kept until processing succeeds so a failure can be
		// retried. Context: `captures:<id>:audio`.
		audio: bytea('audio'),
		// Encrypted `CaptureBody` JSON. Context: `captures:<id>:body`.
		body: bytea('body').notNull()
	},
	(table) => [index('captures_user_created_idx').on(table.userId, table.createdAt)]
);
