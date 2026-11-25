import {
	boolean,
	customType,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uuid
} from 'drizzle-orm/pg-core';
import type { CaptureStatus, ItemType, OperationKind } from '../../items.ts';

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
	recoveryKey: bytea('recovery_key').notNull(),
	// Encrypted JSON of the user's settings (`Settings` in `src/lib/server/settings.ts`),
	// or null before they first save. Context: `users:<id>:settings`.
	settings: bytea('settings')
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
		// Whether the body holds an answer, so the inbox can list captures that only
		// answered a question. The answer itself is encrypted in the body.
		answered: boolean('answered').notNull().default(false),
		// Encrypted WAV recording, kept until processing succeeds so a failure can be
		// retried. Context: `captures:<id>:audio`.
		audio: bytea('audio'),
		// Encrypted attached file (an image or a PDF), kept like the audio. Its name and
		// type are in the body. Context: `captures:<id>:file`.
		file: bytea('file'),
		// Encrypted `CaptureBody` JSON. Context: `captures:<id>:body`.
		body: bytea('body').notNull()
	},
	(table) => [index('captures_user_created_idx').on(table.userId, table.createdAt)]
);

// One table for every utility's items: tasks, notes, expenses, and income so far.
export const records = pgTable(
	'records',
	{
		// Set by the app, because the ID is part of the encryption context.
		id: uuid('id').primaryKey(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		type: text('type').$type<ItemType>().notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
		// Set when a task is done.
		completedAt: timestamp('completed_at', { withTimezone: true }),
		// Encrypted `ItemFields` JSON. Context: `records:<id>:body`.
		body: bytea('body').notNull()
	},
	(table) => [index('records_user_type_idx').on(table.userId, table.type)]
);

// Text that search by meaning compares, with its embedding: a note's own text
// (`note`), or a passage of a document's text kept with its note (`document`).
// Deleting the note deletes them, and undoing that delete brings back the note only.
export const passages = pgTable(
	'passages',
	{
		// Set by the app, because the ID is part of the encryption context.
		id: uuid('id').primaryKey(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		recordId: uuid('record_id')
			.notNull()
			.references(() => records.id, { onDelete: 'cascade' }),
		kind: text('kind').$type<'note' | 'document'>().notNull(),
		// The passage's place in its document, from 0.
		position: integer('position').notNull(),
		// Encrypted JSON: a document passage's `{ text, page }`, or the hash of the
		// note text that was embedded. Context: `passages:<id>:body`.
		body: bytea('body').notNull(),
		// Encrypted float32 embedding. Context: `passages:<id>:embedding`.
		embedding: bytea('embedding').notNull()
	},
	(table) => [
		index('passages_user_idx').on(table.userId),
		index('passages_record_idx').on(table.recordId)
	]
);

// A user's calendar subscription of task reminders. Apple fetches it while the user
// is away, when the data key isn't available, so the feed has its own key and a
// ready-made copy of the reminders. The feed key is wrapped twice: by the data key,
// so a request can rewrite the copy, and by the link's token, so a fetch can read
// it. The token unlocks only this copy, never the data key.
export const calendarFeeds = pgTable('calendar_feeds', {
	userId: uuid('user_id')
		.primaryKey()
		.references(() => users.id, { onDelete: 'cascade' }),
	// SHA-256 of the link's token, which is only ever in the link.
	tokenHash: text('token_hash').notNull().unique(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	// The feed key, wrapped by the data key. Context: `calendar_feeds:<user id>:account-key`.
	keyByAccount: bytea('key_by_account').notNull(),
	// The feed key, wrapped by a key derived from the token.
	// Context: `calendar_feeds:<user id>:token-key`.
	keyByToken: bytea('key_by_token').notNull(),
	// The iCalendar text, encrypted with the feed key. Context: `calendar_feeds:<user id>:body`.
	body: bytea('body').notNull()
});

// Every change made to the records, by a capture or by a tap on a utility screen,
// so each one can be undone.
export const operations = pgTable(
	'operations',
	{
		// Set by the app, because the ID is part of the encryption context.
		id: uuid('id').primaryKey(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		// Null for a change made by tapping on a utility screen.
		captureId: uuid('capture_id').references(() => captures.id, { onDelete: 'cascade' }),
		// No foreign key: the record is gone after a delete, and comes back on undo.
		recordId: uuid('record_id').notNull(),
		kind: text('kind').$type<OperationKind>().notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		undoneAt: timestamp('undone_at', { withTimezone: true }),
		// Encrypted JSON with the record's state before and after.
		// Context: `operations:<id>:body`.
		body: bytea('body').notNull()
	},
	(table) => [
		index('operations_capture_idx').on(table.captureId),
		index('operations_record_idx').on(table.recordId)
	]
);

// Transactions read from bank statements. A row waits in review (`review`) until the
// user decides what it is, then keeps only its key and outcome (`done`), so the same
// transaction in a later statement is recognised and skipped. The statement file
// itself is never stored.
export const statementRows = pgTable(
	'statement_rows',
	{
		// Set by the app, because the ID is part of the encryption context.
		id: uuid('id').primaryKey(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		status: text('status').$type<'review' | 'done'>().notNull(),
		// Encrypted `StatementRowBody` JSON (`src/lib/server/imports.ts`).
		// Context: `statement_rows:<id>:body`.
		body: bytea('body').notNull()
	},
	(table) => [index('statement_rows_user_status_idx').on(table.userId, table.status)]
);
