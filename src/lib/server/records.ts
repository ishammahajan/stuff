import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import {
	addDays,
	daysBetween,
	describeRepeat,
	ITEM_TYPES,
	nextOccurrence,
	withDefaults,
	type Item,
	type ItemFields,
	type ItemType,
	type OperationKind,
	type OperationView,
	type TaskView
} from '../items.ts';
import type { Account } from './auth.ts';
import { decryptJson, encryptJson } from './crypto.ts';
import { db } from './db/index.ts';
import { operations, records } from './db/schema.ts';

/** A change the model asked for, already checked for shape but not against the records. */
export type ProposedOperation =
	// `recordId` is set by the server when something must refer to the new record.
	| { action: 'create'; type: ItemType; fields: ItemFields; recordId?: string }
	| { action: 'update'; id: string; changes: Partial<ItemFields> }
	| { action: 'complete'; id: string }
	| { action: 'reopen'; id: string }
	| { action: 'delete'; id: string };

/** A decrypted record. */
export interface StoredRecord {
	id: string;
	type: ItemType;
	createdAt: Date;
	updatedAt: Date;
	completedAt: Date | null;
	fields: ItemFields;
}

/** A record's full state, as the operation log keeps it. */
interface RecordState {
	type: ItemType;
	fields: ItemFields;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
}

/** The encrypted part of an operation. `null` means the record didn't exist. */
interface OperationBody {
	before: RecordState | null;
	after: RecordState | null;
}

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const recordContext = (id: string) => `records:${id}:body`;
const operationContext = (id: string) => `operations:${id}:body`;

function ownedRecord(account: Account, id: string) {
	return and(eq(records.id, id), eq(records.userId, account.id));
}

type RecordRow = typeof records.$inferSelect;

function decryptRecord(account: Account, row: RecordRow): StoredRecord {
	return {
		id: row.id,
		type: row.type,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		completedAt: row.completedAt,
		fields: withDefaults(decryptJson<ItemFields>(account.key, row.body, recordContext(row.id)))
	};
}

function toState(record: StoredRecord): RecordState {
	return {
		type: record.type,
		fields: record.fields,
		createdAt: record.createdAt.toISOString(),
		updatedAt: record.updatedAt.toISOString(),
		completedAt: record.completedAt?.toISOString() ?? null
	};
}

function toItem(state: RecordState): Item {
	return { type: state.type, ...withDefaults(state.fields), completed: state.completedAt !== null };
}

/** Makes the stored record match `state`: inserts, updates, or deletes it. */
async function writeState(
	tx: Transaction,
	account: Account,
	id: string,
	exists: boolean,
	state: RecordState | null
): Promise<void> {
	if (!state) {
		await tx.delete(records).where(ownedRecord(account, id));
		return;
	}
	const values = {
		type: state.type,
		createdAt: new Date(state.createdAt),
		updatedAt: new Date(state.updatedAt),
		completedAt: state.completedAt ? new Date(state.completedAt) : null,
		body: encryptJson(account.key, state.fields, recordContext(id))
	};
	if (exists) {
		await tx.update(records).set(values).where(ownedRecord(account, id));
	} else {
		await tx.insert(records).values({ id, userId: account.id, ...values });
	}
}

/** Loads and decrypts all of the account's records. */
export async function loadRecords(account: Account): Promise<StoredRecord[]> {
	const rows = await db.select().from(records).where(eq(records.userId, account.id));
	return rows.map((row) => decryptRecord(account, row));
}

/** How many records of each type the model sees up front. */
const SNAPSHOT_LIMITS: Record<ItemType, number> = { task: 50, note: 20, expense: 20, income: 10 };

/** A short form of a record for the model. Empty fields are left out. */
export function summary(record: StoredRecord, detailsLimit?: number) {
	const {
		title,
		details,
		amount,
		currency,
		date,
		tags,
		important,
		repeat,
		remindAt,
		list,
		category,
		shares
	} = record.fields;
	return {
		id: record.id,
		type: record.type,
		title,
		...(details ? { details: detailsLimit ? details.slice(0, detailsLimit) : details } : {}),
		...(amount !== null ? { amount } : {}),
		...(currency ? { currency } : {}),
		...(date ? { date } : {}),
		...(tags.length ? { tags } : {}),
		...(important ? { important } : {}),
		...(repeat ? { repeat: describeRepeat(repeat) } : {}),
		...(remindAt ? { remindAt } : {}),
		...(list ? { list } : {}),
		...(category ? { category } : {}),
		...(shares.length ? { shares } : {}),
		...(record.completedAt ? { completed: true } : {})
	};
}

/**
 * Lists the most recently changed records of each type, one JSON object per line:
 * open tasks, and the latest notes, expenses, and income.
 */
export function snapshot(all: StoredRecord[]): string {
	const lines: string[] = [];
	for (const type of ITEM_TYPES) {
		const recent = all
			.filter((record) => record.type === type && !(type === 'task' && record.completedAt))
			.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
			.slice(0, SNAPSHOT_LIMITS[type]);
		for (const record of recent) lines.push(JSON.stringify(summary(record, 100)));
	}
	return lines.join('\n');
}

/** Lists the given records, one JSON object per line, skipping IDs the account lacks. */
export function describeRecords(all: StoredRecord[], ids: string[]): string {
	const wanted = new Set(ids);
	return all
		.filter((record) => wanted.has(record.id))
		.map((record) => JSON.stringify(summary(record)))
		.join('\n');
}

const SEARCH_LIMIT = 20;

/** Finds records containing the most query words in their text, best first. */
export function searchRecords(all: StoredRecord[], query: string, type: ItemType | null) {
	const words = query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word.length > 1);
	if (words.length === 0) return [];
	return all
		.filter((record) => type === null || record.type === type)
		.map((record) => {
			const { title, details, amount, date, tags, list } = record.fields;
			const text = [title, details, amount, date, list, ...tags].join(' ').toLowerCase();
			return { record, score: words.filter((word) => text.includes(word)).length };
		})
		.filter(({ score }) => score > 0)
		.sort(
			(a, b) => b.score - a.score || b.record.updatedAt.getTime() - a.record.updatedAt.getTime()
		)
		.slice(0, SEARCH_LIMIT)
		.map(({ record }) => summary(record));
}

const LIST_LIMIT = 100;

/** Which records the list tool returns. Null fields don't filter. */
export interface ListFilter {
	type: ItemType;
	/** First and last date, YYYY-MM-DD, on the record's own date. */
	from: string | null;
	to: string | null;
	tag: string | null;
	/** A note list's name, matched without regard to case. */
	list: string | null;
	/** For tasks: done (true) or open (false). */
	completed: boolean | null;
}

/** The names of the account's note lists, most used first. */
export function listNames(all: StoredRecord[]): string[] {
	const counts = new Map<string, number>();
	for (const record of all) {
		const { list } = record.fields;
		if (record.type === 'note' && list) counts.set(list, (counts.get(list) ?? 0) + 1);
	}
	return [...counts].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

/** Lists records of one type, newest first: by their date, or by last change without one. */
export function listRecords(all: StoredRecord[], filter: ListFilter) {
	const { type, from, to, tag, list, completed } = filter;
	const ranged = from !== null || to !== null;
	const sortKey = (record: StoredRecord) =>
		record.fields.date ?? record.updatedAt.toISOString().slice(0, 10);
	const matches = all
		.filter((record) => {
			const { date, tags } = record.fields;
			if (record.type !== type) return false;
			if (ranged && (!date || (from && date < from) || (to && date > to))) return false;
			if (tag && !tags.includes(tag)) return false;
			if (list && record.fields.list?.toLowerCase() !== list.toLowerCase()) return false;
			if (completed !== null && (record.completedAt !== null) !== completed) return false;
			return true;
		})
		.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
	return {
		total: matches.length,
		records: matches.slice(0, LIST_LIMIT).map((record) => summary(record, 300))
	};
}

/**
 * Applies operations inside the caller's transaction and logs each one, under the
 * capture that asked for them, or under none for a tap on a utility screen.
 * Operations on a record the account doesn't have, and a second operation on the
 * same record, are skipped. `today` is the user's local date, which places the next
 * occurrence of a repeating task. Returns the IDs of the logged operations.
 */
export async function applyOperations(
	tx: Transaction,
	account: Account,
	captureId: string | null,
	proposed: ProposedOperation[],
	today: string
): Promise<string[]> {
	const start = Date.now();
	const touched = new Set<string>();
	const logged: string[] = [];
	for (const operation of proposed) {
		// Each operation gets its own millisecond, so the log keeps their order.
		const now = new Date(start + touched.size);
		let id: string;
		let before: RecordState | null = null;
		if (operation.action === 'create') {
			id = operation.recordId ?? randomUUID();
		} else {
			id = operation.id;
			if (!UUID.test(id) || touched.has(id)) continue;
			const [row] = await tx.select().from(records).where(ownedRecord(account, id)).limit(1);
			if (!row) continue;
			before = toState(decryptRecord(account, row));
			if (operation.action === 'complete' && (before.type !== 'task' || before.completedAt)) {
				continue;
			}
			if (operation.action === 'reopen' && (before.type !== 'task' || !before.completedAt)) {
				continue;
			}
		}

		let after: RecordState | null;
		switch (operation.action) {
			case 'create':
				after = {
					type: operation.type,
					fields: operation.fields,
					createdAt: now.toISOString(),
					updatedAt: now.toISOString(),
					completedAt: null
				};
				break;
			case 'update':
				after = {
					...before!,
					fields: { ...before!.fields, ...operation.changes },
					updatedAt: now.toISOString()
				};
				break;
			case 'complete': {
				const { repeat, date, remindAt } = before!.fields;
				if (repeat) {
					// A repeating task stays open and moves to its next date, and its
					// reminder moves by the same number of days.
					const next = nextOccurrence(date, repeat, today);
					const shift = daysBetween(date ?? today, next);
					after = {
						...before!,
						fields: {
							...before!.fields,
							date: next,
							remindAt: remindAt && addDays(remindAt, shift)
						},
						updatedAt: now.toISOString()
					};
				} else {
					after = { ...before!, completedAt: now.toISOString(), updatedAt: now.toISOString() };
				}
				break;
			}
			case 'reopen':
				after = { ...before!, completedAt: null, updatedAt: now.toISOString() };
				break;
			case 'delete':
				after = null;
				break;
		}

		await writeState(tx, account, id, before !== null, after);
		const operationId = randomUUID();
		const body: OperationBody = { before, after };
		await tx.insert(operations).values({
			id: operationId,
			userId: account.id,
			captureId,
			recordId: id,
			kind: operation.action,
			createdAt: now,
			body: encryptJson(account.key, body, operationContext(operationId))
		});
		touched.add(id);
		logged.push(operationId);
	}
	return logged;
}

// Completed tasks the Tasks screen lists, newest first, beyond the open ones.
const COMPLETED_LIMIT = 100;

/** Lists the open tasks and the most recently completed ones. */
export async function listTasks(account: Account): Promise<TaskView[]> {
	const rows = await db
		.select()
		.from(records)
		.where(and(eq(records.userId, account.id), eq(records.type, 'task')));
	const tasks = rows.map((row) => decryptRecord(account, row));
	const open = tasks.filter((task) => !task.completedAt);
	const completed = tasks
		.filter((task) => task.completedAt)
		.sort((a, b) => b.completedAt!.getTime() - a.completedAt!.getTime())
		.slice(0, COMPLETED_LIMIT);
	return [...open, ...completed].map((task) => ({
		id: task.id,
		...task.fields,
		completedAt: task.completedAt?.toISOString() ?? null
	}));
}

/** Lists the account's notes, newest first. */
export async function listNotes(account: Account): Promise<StoredRecord[]> {
	const rows = await db
		.select()
		.from(records)
		.where(and(eq(records.userId, account.id), eq(records.type, 'note')));
	return rows
		.map((row) => decryptRecord(account, row))
		.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** Lists the account's expenses and income. */
export async function listMoney(account: Account): Promise<StoredRecord[]> {
	const rows = await db
		.select()
		.from(records)
		.where(and(eq(records.userId, account.id), inArray(records.type, ['expense', 'income'])));
	return rows.map((row) => decryptRecord(account, row));
}

/**
 * Completes, reopens, or deletes one of the account's records of `type` from a tap.
 * Returns the logged operation's ID, or null when the record is gone or already in
 * that state.
 */
export async function changeRecord(
	account: Account,
	id: string,
	type: ItemType,
	action: 'complete' | 'reopen' | 'delete',
	today: string
): Promise<string | null> {
	if (!UUID.test(id)) return null;
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select({ type: records.type })
			.from(records)
			.where(ownedRecord(account, id))
			.limit(1);
		if (row?.type !== type) return null;
		const [operationId] = await applyOperations(tx, account, null, [{ action, id }], today);
		return operationId ?? null;
	});
}

/**
 * Marks one share of an expense as paid back, from a tap. The share is found by its
 * place in the list and checked by the person's name, so a list that changed in the
 * meantime isn't settled by mistake. Returns the logged operation's ID, or null when
 * the expense or the unsettled share is gone.
 */
export async function settleShare(
	account: Account,
	id: string,
	index: number,
	person: string,
	today: string
): Promise<string | null> {
	if (!UUID.test(id)) return null;
	return db.transaction(async (tx) => {
		const [row] = await tx.select().from(records).where(ownedRecord(account, id)).limit(1);
		if (row?.type !== 'expense') return null;
		const { shares } = decryptRecord(account, row).fields;
		const share = shares[index];
		if (!share || share.person !== person || share.settled) return null;
		const changes = { shares: shares.map((s, i) => (i === index ? { ...s, settled: true } : s)) };
		const [operationId] = await applyOperations(tx, account, null, [{ action: 'update', id, changes }], today);
		return operationId ?? null;
	});
}

/**
 * Puts a record back the way it was before an operation. Only the latest change to
 * a record can be undone, so that undoing never overwrites a later change.
 * Returns a message for the user when the operation can't be undone.
 */
export async function undoOperation(account: Account, id: string): Promise<string | null> {
	return db.transaction(async (tx) => {
		const [operation] = await tx
			.select()
			.from(operations)
			.where(
				and(eq(operations.id, id), eq(operations.userId, account.id), isNull(operations.undoneAt))
			)
			.limit(1);
		if (!operation) return 'That change was already undone.';

		const [later] = await tx
			.select({ id: operations.id })
			.from(operations)
			.where(
				and(
					eq(operations.userId, account.id),
					eq(operations.recordId, operation.recordId),
					isNull(operations.undoneAt),
					gt(operations.createdAt, operation.createdAt)
				)
			)
			.limit(1);
		if (later) return 'Undo the later change to this item first.';

		const marked = await tx
			.update(operations)
			.set({ undoneAt: new Date() })
			.where(and(eq(operations.id, id), isNull(operations.undoneAt)))
			.returning({ id: operations.id });
		if (marked.length === 0) return 'That change was already undone.';

		const body = decryptJson<OperationBody>(account.key, operation.body, operationContext(id));
		await writeState(tx, account, operation.recordId, body.after !== null, body.before);
		return null;
	});
}

/** Returns the operations of the given captures, in the order they were applied. */
export async function listOperations(
	account: Account,
	captureIds: string[]
): Promise<Map<string, OperationView[]>> {
	const byCapture = new Map<string, OperationView[]>();
	if (captureIds.length === 0) return byCapture;
	const rows = await db
		.select()
		.from(operations)
		.where(and(eq(operations.userId, account.id), inArray(operations.captureId, captureIds)))
		.orderBy(asc(operations.createdAt));
	for (const row of rows) {
		const body = decryptJson<OperationBody>(account.key, row.body, operationContext(row.id));
		const shown = body.after ?? body.before!;
		const view: OperationView = {
			id: row.id,
			kind: row.kind as OperationKind,
			item: toItem(shown),
			previous: row.kind === 'update' && body.before ? toItem(body.before) : null,
			undone: row.undoneAt !== null
		};
		// Only captures' operations are selected, so the capture ID is set.
		const captureId = row.captureId!;
		byCapture.set(captureId, [...(byCapture.get(captureId) ?? []), view]);
	}
	return byCapture;
}
