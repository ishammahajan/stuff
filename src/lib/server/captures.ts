import { randomUUID } from 'node:crypto';
import { and, desc, eq, exists, isNotNull, ne, or } from 'drizzle-orm';
import type { CaptureStatus, CaptureView, OperationView } from '../items.ts';
import type { Account } from './auth.ts';
import { decrypt, decryptJson, encrypt, encryptJson } from './crypto.ts';
import { db } from './db/index.ts';
import { captures, operations } from './db/schema.ts';
import { interpretAudio } from './openrouter.ts';
import {
	applyOperations,
	listOperations,
	loadRecords,
	searchRecords,
	snapshot,
	type ProposedOperation
} from './records.ts';

// 16 kHz mono 16-bit WAV is about 32 kB per second, so this allows roughly four minutes.
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/** The encrypted part of a capture. */
interface CaptureBody {
	// The speaker's local date and time zone, used to resolve "today" or "tomorrow".
	localDate: string;
	timeZone: string;
	transcript: string | null;
	error: string | null;
}

const audioContext = (id: string) => `captures:${id}:audio`;
const bodyContext = (id: string) => `captures:${id}:body`;

function ownedBy(account: Account, id: string) {
	return and(eq(captures.id, id), eq(captures.userId, account.id));
}

export function isWav(audio: Buffer): boolean {
	return (
		audio.length > 44 &&
		audio.toString('ascii', 0, 4) === 'RIFF' &&
		audio.toString('ascii', 8, 12) === 'WAVE'
	);
}

export async function createCapture(
	account: Account,
	audio: Buffer,
	localDate: string,
	timeZone: string
): Promise<string> {
	const id = randomUUID();
	const body: CaptureBody = { localDate, timeZone, transcript: null, error: null };
	await db.insert(captures).values({
		id,
		userId: account.id,
		audio: encrypt(account.key, audio, audioContext(id)),
		body: encryptJson(account.key, body, bodyContext(id))
	});
	return id;
}

// Captures being processed by this server process, so that a retry or a resume
// can't start a second model call for a capture that is already in progress.
const inProgress = new Set<string>();

/**
 * Runs the model over a capture's stored audio and applies the result.
 * The audio is dropped on success and kept on failure, so a failure can be retried.
 * The account's key is held only for as long as this runs.
 */
export async function processCapture(account: Account, id: string): Promise<void> {
	if (inProgress.has(id)) return;
	inProgress.add(id);
	try {
		await interpretCapture(account, id);
	} finally {
		inProgress.delete(id);
	}
}

/** Starts processing without waiting for it. Errors are logged, not thrown. */
export function processInBackground(account: Account, id: string): void {
	processCapture(account, id).catch((error) =>
		console.error(`Capture ${id} failed to process:`, error)
	);
}

/**
 * Restarts processing for the account's captures left pending, for example by a
 * server restart during a model call. Runs when the user is back, because only
 * their session can unlock the key. Failed captures wait for a retry instead.
 */
export async function resumePendingCaptures(account: Account): Promise<void> {
	const rows = await db
		.select({ id: captures.id })
		.from(captures)
		.where(
			and(
				eq(captures.userId, account.id),
				eq(captures.status, 'pending'),
				isNotNull(captures.audio)
			)
		);
	for (const { id } of rows) processInBackground(account, id);
}

/** Thrown inside a transaction to roll it back when another run already finished. */
class AlreadyDone extends Error {}

/**
 * Applies operations and saves the capture's new body in one transaction, unless
 * the capture is already done.
 */
async function finishCapture(
	account: Account,
	id: string,
	body: CaptureBody,
	proposed: ProposedOperation[]
): Promise<void> {
	try {
		await db.transaction(async (tx) => {
			const updated = await tx
				.update(captures)
				.set({ status: 'done', audio: null, body: encryptJson(account.key, body, bodyContext(id)) })
				.where(and(ownedBy(account, id), ne(captures.status, 'done')))
				.returning({ id: captures.id });
			if (updated.length === 0) throw new AlreadyDone();
			await applyOperations(tx, account, id, proposed);
		});
	} catch (error) {
		if (!(error instanceof AlreadyDone)) throw error;
	}
}

async function interpretCapture(account: Account, id: string): Promise<void> {
	const [row] = await db
		.select({ audio: captures.audio, body: captures.body })
		.from(captures)
		.where(ownedBy(account, id))
		.limit(1);
	if (!row?.audio) return;

	const body = decryptJson<CaptureBody>(account.key, row.body, bodyContext(id));
	const audio = decrypt(account.key, row.audio, audioContext(id));

	let result;
	try {
		const all = await loadRecords(account);
		result = await interpretAudio(audio, {
			localDate: body.localDate,
			timeZone: body.timeZone,
			snapshot: snapshot(all),
			search: (query, type) => searchRecords(all, query, type)
		});
	} catch (error) {
		const failed = { ...body, error: error instanceof Error ? error.message : String(error) };
		await db
			.update(captures)
			.set({ status: 'failed', body: encryptJson(account.key, failed, bodyContext(id)) })
			.where(ownedBy(account, id));
		return;
	}

	await finishCapture(
		account,
		id,
		{ ...body, transcript: result.transcript, error: null },
		result.operations
	);
}

const viewColumns = {
	id: captures.id,
	createdAt: captures.createdAt,
	status: captures.status,
	body: captures.body
};

function toView(
	account: Account,
	row: { id: string; createdAt: Date; status: CaptureStatus; body: Buffer },
	operations: OperationView[]
): CaptureView {
	const body = decryptJson<CaptureBody>(account.key, row.body, bodyContext(row.id));
	return {
		id: row.id,
		createdAt: row.createdAt,
		status: row.status,
		transcript: body.transcript,
		operations,
		error: body.error
	};
}

export async function getCapture(account: Account, id: string): Promise<CaptureView | null> {
	const [row] = await db.select(viewColumns).from(captures).where(ownedBy(account, id)).limit(1);
	if (!row) return null;
	const byCapture = await listOperations(account, [row.id]);
	return toView(account, row, byCapture.get(row.id) ?? []);
}

/**
 * Lists the latest captures. A capture that filed nothing, such as a recording of
 * background speech, is left out.
 */
export async function listCaptures(account: Account, limit = 50): Promise<CaptureView[]> {
	const rows = await db
		.select(viewColumns)
		.from(captures)
		.where(
			and(
				eq(captures.userId, account.id),
				or(
					ne(captures.status, 'done'),
					exists(
						db
							.select({ id: operations.id })
							.from(operations)
							.where(eq(operations.captureId, captures.id))
					)
				)
			)
		)
		.orderBy(desc(captures.createdAt))
		.limit(limit);
	const byCapture = await listOperations(
		account,
		rows.map((row) => row.id)
	);
	return rows.map((row) => toView(account, row, byCapture.get(row.id) ?? []));
}

export async function deleteCapture(account: Account, id: string): Promise<void> {
	await db.delete(captures).where(ownedBy(account, id));
}
