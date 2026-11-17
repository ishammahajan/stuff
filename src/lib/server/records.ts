import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import {
	ITEM_TYPES,
	type Item,
	type ItemFields,
	type ItemType,
	type OperationKind,
	type OperationView
} from '../items.ts';
import type { Account } from './auth.ts';
import { decryptJson, encryptJson } from './crypto.ts';
import { db } from './db/index.ts';
import { operations, records } from './db/schema.ts';

/** A change the model asked for, already checked for shape but not against the records. */
export type ProposedOperation =
	| { action: 'create'; type: ItemType; fields: ItemFields }
	| { action: 'update'; id: string; changes: Partial<ItemFields> }
	| { action: 'complete'; id: string }
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

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
		fields: decryptJson<ItemFields>(account.key, row.body, recordContext(row.id))
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
	return { type: state.type, ...state.fields, completed: state.completedAt !== null };
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
function summary(record: StoredRecord, detailsLimit?: number) {
	const { title, details, amount, currency, date, tags } = record.fields;
	return {
		id: record.id,
		type: record.type,
		title,
		...(details ? { details: detailsLimit ? details.slice(0, detailsLimit) : details } : {}),
		...(amount !== null ? { amount } : {}),
		...(currency ? { currency } : {}),
		...(date ? { date } : {}),
		...(tags.length ? { tags } : {}),
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
			const { title, details, amount, date, tags } = record.fields;
			const text = [title, details, amount, date, ...tags].join(' ').toLowerCase();
			return { record, score: words.filter((word) => text.includes(word)).length };
		})
		.filter(({ score }) => score > 0)
		.sort(
			(a, b) => b.score - a.score || b.record.updatedAt.getTime() - a.record.updatedAt.getTime()
		)
		.slice(0, SEARCH_LIMIT)
		.map(({ record }) => summary(record));
}

/**
 * Applies a capture's operations inside the caller's transaction and logs each
 * one. Operations on a record the account doesn't have, and a second operation on
 * the same record, are skipped. Returns how many were applied.
 */
export async function applyOperations(
	tx: Transaction,
	account: Account,
	captureId: string,
	proposed: ProposedOperation[]
): Promise<number> {
	const start = Date.now();
	const touched = new Set<string>();
	for (const operation of proposed) {
		// Each operation gets its own millisecond, so the log keeps their order.
		const now = new Date(start + touched.size);
		let id: string;
		let before: RecordState | null = null;
		if (operation.action === 'create') {
			id = randomUUID();
		} else {
			id = operation.id;
			if (!UUID.test(id) || touched.has(id)) continue;
			const [row] = await tx.select().from(records).where(ownedRecord(account, id)).limit(1);
			if (!row) continue;
			before = toState(decryptRecord(account, row));
			if (operation.action === 'complete' && (before.type !== 'task' || before.completedAt)) {
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
			case 'complete':
				after = { ...before!, completedAt: now.toISOString(), updatedAt: now.toISOString() };
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
	}
	return touched.size;
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
		byCapture.set(row.captureId, [...(byCapture.get(row.captureId) ?? []), view]);
	}
	return byCapture;
}
