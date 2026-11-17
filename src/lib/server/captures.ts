import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { CaptureStatus, CaptureView, Item } from '../items.ts';
import type { Account } from './auth.ts';
import { decrypt, decryptJson, encrypt, encryptJson } from './crypto.ts';
import { db } from './db/index.ts';
import { captures } from './db/schema.ts';
import { interpretAudio } from './openrouter.ts';

// 16 kHz mono 16-bit WAV is about 32 kB per second, so this allows roughly four minutes.
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/** The encrypted part of a capture. */
interface CaptureBody {
	// The speaker's local date and time zone, used to resolve "today" or "tomorrow".
	localDate: string;
	timeZone: string;
	transcript: string | null;
	items: Item[] | null;
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
	const body: CaptureBody = { localDate, timeZone, transcript: null, items: null, error: null };
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
 * Runs the model over a capture's stored audio and records the outcome.
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

async function interpretCapture(account: Account, id: string): Promise<void> {
	const [row] = await db
		.select({ audio: captures.audio, body: captures.body })
		.from(captures)
		.where(ownedBy(account, id))
		.limit(1);
	if (!row?.audio) return;

	const body = decryptJson<CaptureBody>(account.key, row.body, bodyContext(id));
	const audio = decrypt(account.key, row.audio, audioContext(id));

	let status: CaptureStatus;
	let result: CaptureBody;
	try {
		const { transcript, items } = await interpretAudio(audio, body.localDate, body.timeZone);
		status = 'done';
		result = { ...body, transcript, items, error: null };
	} catch (error) {
		status = 'failed';
		result = { ...body, error: error instanceof Error ? error.message : String(error) };
	}

	await db
		.update(captures)
		.set({
			status,
			body: encryptJson(account.key, result, bodyContext(id)),
			...(status === 'done' ? { audio: null } : {})
		})
		.where(ownedBy(account, id));
}

const viewColumns = {
	id: captures.id,
	createdAt: captures.createdAt,
	status: captures.status,
	body: captures.body
};

function toView(
	account: Account,
	row: { id: string; createdAt: Date; status: CaptureStatus; body: Buffer }
): CaptureView {
	const body = decryptJson<CaptureBody>(account.key, row.body, bodyContext(row.id));
	return {
		id: row.id,
		createdAt: row.createdAt,
		status: row.status,
		transcript: body.transcript,
		items: body.items ?? [],
		error: body.error
	};
}

export async function getCapture(account: Account, id: string): Promise<CaptureView | null> {
	const [row] = await db.select(viewColumns).from(captures).where(ownedBy(account, id)).limit(1);
	return row ? toView(account, row) : null;
}

export async function listCaptures(account: Account, limit = 50): Promise<CaptureView[]> {
	const rows = await db
		.select(viewColumns)
		.from(captures)
		.where(eq(captures.userId, account.id))
		.orderBy(desc(captures.createdAt))
		.limit(limit);
	return rows.map((row) => toView(account, row));
}

export async function deleteCapture(account: Account, id: string): Promise<void> {
	await db.delete(captures).where(ownedBy(account, id));
}
