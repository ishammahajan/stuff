import { randomUUID } from 'node:crypto';
import { and, desc, eq, exists, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import type { CaptureStatus, CaptureView, ItemType, OperationView } from '../items.ts';
import type { Account } from './auth.ts';
import { refreshFeedQuietly } from './calendar.ts';
import { decrypt, decryptJson, encrypt, encryptJson } from './crypto.ts';
import { db } from './db/index.ts';
import { captures, operations } from './db/schema.ts';
import { interpretMemo, type ProposedQuestion, type ReplyContext } from './openrouter.ts';
import {
	applyOperations,
	describeRecords,
	listOperations,
	loadRecords,
	searchRecords,
	snapshot,
	type ProposedOperation,
	type Transaction
} from './records.ts';
import { keepSpeech } from './speech.ts';

// 16 kHz mono 16-bit WAV is about 32 kB per second, so this allows roughly four minutes.
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** An attached file's name and its type, as detected from its content. */
export interface FileInfo {
	name: string;
	type: string;
}

/** The encrypted part of a capture. */
interface CaptureBody {
	// The speaker's local date and time zone, used to resolve "today" or "tomorrow".
	localDate: string;
	timeZone: string;
	transcript: string | null;
	error: string | null;
	// The question the model asked instead of guessing, with what settled it.
	question?: (ProposedQuestion & { answer: string | null }) | null;
	// The capture whose open question this recording answers.
	replyTo?: string | null;
	// The attached file, if any. Its content is in `captures.file`.
	file?: FileInfo | null;
	// The records the speaker dragged onto the pill, by ID.
	items?: string[];
	// The utility screen the memo was recorded on, by its record type.
	screen?: ItemType | null;
}

const audioContext = (id: string) => `captures:${id}:audio`;
const bodyContext = (id: string) => `captures:${id}:body`;
const fileContext = (id: string) => `captures:${id}:file`;

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

/**
 * Returns the type of an image or a PDF that the model can read, from the file's
 * first bytes, or null for any other file.
 */
export function attachmentType(file: Buffer): string | null {
	const ascii = (start: number, end: number) => file.toString('ascii', start, end);
	if (file.length < 12) return null;
	if (ascii(0, 5) === '%PDF-') return 'application/pdf';
	if (file[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
	if (file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff) return 'image/jpeg';
	if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
	if (ascii(4, 8) === 'ftyp') {
		const brand = ascii(8, 12);
		if (['heic', 'heix', 'hevc', 'heim', 'heis'].includes(brand)) return 'image/heic';
		if (['mif1', 'msf1', 'heif'].includes(brand)) return 'image/heif';
	}
	return null;
}

export interface NewCapture {
	audio: Buffer | null;
	file: { data: Buffer; info: FileInfo } | null;
	localDate: string;
	timeZone: string;
	/** The capture whose open question this one answers. */
	replyTo: string | null;
	/** IDs of the records the speaker selected. They are checked when filing. */
	items: string[];
	screen: ItemType | null;
}

export async function createCapture(account: Account, capture: NewCapture): Promise<string> {
	const id = randomUUID();
	const { localDate, timeZone, replyTo, items, screen } = capture;
	const body: CaptureBody = {
		localDate,
		timeZone,
		transcript: null,
		error: null,
		replyTo,
		file: capture.file?.info ?? null,
		items,
		screen
	};
	await db.insert(captures).values({
		id,
		userId: account.id,
		audio: capture.audio && encrypt(account.key, capture.audio, audioContext(id)),
		file: capture.file && encrypt(account.key, capture.file.data, fileContext(id)),
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
				or(isNotNull(captures.audio), isNotNull(captures.file))
			)
		);
	for (const { id } of rows) processInBackground(account, id);
}

/** Thrown inside a transaction to roll it back when another run already finished. */
class AlreadyDone extends Error {}

/**
 * Applies operations and saves the capture's new body in one transaction, unless
 * another run already finished the capture. A capture with an open question waits
 * in `asking`. A reply also closes the question it answers.
 */
async function finishCapture(
	account: Account,
	id: string,
	body: CaptureBody,
	proposed: ProposedOperation[],
	answers: string | null
): Promise<void> {
	const status: CaptureStatus = body.question ? 'asking' : 'done';
	try {
		await db.transaction(async (tx) => {
			const updated = await tx
				.update(captures)
				.set({
					status,
					audio: null,
					file: null,
					body: encryptJson(account.key, body, bodyContext(id))
				})
				.where(and(ownedBy(account, id), inArray(captures.status, ['pending', 'failed'])))
				.returning({ id: captures.id });
			if (updated.length === 0) throw new AlreadyDone();
			await applyOperations(tx, account, id, proposed, body.localDate);
			if (answers) await closeQuestion(tx, account, answers, 'Answered by voice');
		});
		if (proposed.length > 0) await refreshFeedQuietly(account);
	} catch (error) {
		if (!(error instanceof AlreadyDone)) throw error;
	}
}

/** Reads a capture's open question, or returns null when it has none. */
async function openQuestion(
	executor: Transaction | typeof db,
	account: Account,
	id: string
): Promise<CaptureBody | null> {
	const [row] = await executor
		.select({ body: captures.body })
		.from(captures)
		.where(and(ownedBy(account, id), eq(captures.status, 'asking')))
		.limit(1);
	if (!row) return null;
	const body = decryptJson<CaptureBody>(account.key, row.body, bodyContext(id));
	return body.question && !body.question.answer ? body : null;
}

/** Whether the capture is the account's and waits for an answer. */
export async function isOpenQuestion(account: Account, id: string): Promise<boolean> {
	return (await openQuestion(db, account, id)) !== null;
}

/**
 * Records what settled a question and marks its capture done. Returns the body as
 * it was, or null if the question was already closed.
 */
async function closeQuestion(
	tx: Transaction,
	account: Account,
	id: string,
	answer: string
): Promise<CaptureBody | null> {
	const body = await openQuestion(tx, account, id);
	if (!body?.question) return null;
	const closed: CaptureBody = { ...body, question: { ...body.question, answer } };
	const updated = await tx
		.update(captures)
		.set({ status: 'done', body: encryptJson(account.key, closed, bodyContext(id)) })
		.where(and(ownedBy(account, id), eq(captures.status, 'asking')))
		.returning({ id: captures.id });
	return updated.length > 0 ? body : null;
}

/**
 * Settles a capture's open question: applies the chosen option's operations, or
 * changes nothing when `option` is null (dismissed). `today` is the user's local
 * date. Returns a message when the question is no longer open.
 */
export async function answerQuestion(
	account: Account,
	id: string,
	option: number | null,
	today: string
): Promise<string | null> {
	const problem = await db.transaction(async (tx) => {
		const body = await openQuestion(tx, account, id);
		const chosen = option === null ? null : body?.question?.options[option];
		if (!body || (option !== null && !chosen)) return 'This question is no longer open.';
		const closed = await closeQuestion(tx, account, id, chosen ? chosen.label : 'Dismissed');
		if (!closed) return 'This question is no longer open.';
		// The operations are checked again against the account's records as they are now.
		if (chosen) await applyOperations(tx, account, id, chosen.operations, today);
		return null;
	});
	if (!problem && option !== null) await refreshFeedQuietly(account);
	return problem;
}

async function interpretCapture(account: Account, id: string): Promise<void> {
	const [row] = await db
		.select({ audio: captures.audio, file: captures.file, body: captures.body })
		.from(captures)
		.where(ownedBy(account, id))
		.limit(1);
	if (!row || (!row.audio && !row.file)) return;

	const body = decryptJson<CaptureBody>(account.key, row.body, bodyContext(id));
	const file =
		row.file && body.file
			? { data: decrypt(account.key, row.file, fileContext(id)), info: body.file }
			: null;
	const recorded = row.audio && decrypt(account.key, row.audio, audioContext(id));
	const audio = recorded && (await findSpeech(id, recorded));

	// Nothing but noise: there is nothing to send to the model.
	if (!audio && !file) {
		await finishCapture(account, id, { ...body, transcript: '', question: null, error: null }, [], null);
		return;
	}

	// A reply to a question that was settled meanwhile is filed as a plain memo.
	const parent = body.replyTo ? await openQuestion(db, account, body.replyTo) : null;
	const reply: ReplyContext | null = parent?.question
		? {
				transcript: parent.transcript ?? '',
				question: parent.question.text,
				options: parent.question.options
			}
		: null;

	let result;
	try {
		const all = await loadRecords(account);
		result = await interpretMemo({ audio, file }, {
			localDate: body.localDate,
			timeZone: body.timeZone,
			snapshot: snapshot(all),
			search: (query, type) => searchRecords(all, query, type),
			reply,
			screen: body.screen ?? null,
			selected: describeRecords(all, body.items ?? [])
		});
	} catch (error) {
		const failed = { ...body, error: error instanceof Error ? error.message : String(error) };
		await db
			.update(captures)
			.set({ status: 'failed', body: encryptJson(account.key, failed, bodyContext(id)) })
			.where(ownedBy(account, id));
		return;
	}

	const question = result.question ? { ...result.question, answer: null } : null;
	await finishCapture(
		account,
		id,
		{ ...body, transcript: result.transcript, question, error: null },
		result.operations,
		reply ? body.replyTo! : null
	);
}

/**
 * Returns the speech in a recording without long pauses, or null when it has none.
 * If detection itself fails, the whole recording is used.
 */
async function findSpeech(id: string, wav: Buffer): Promise<Buffer | null> {
	try {
		return await keepSpeech(wav);
	} catch (error) {
		console.error(`Speech detection failed for capture ${id}:`, error);
		return wav;
	}
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
		fileName: body.file?.name ?? null,
		operations,
		question: body.question
			? {
					text: body.question.text,
					options: body.question.options.map((option) => option.label),
					answer: body.question.answer
				}
			: null,
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
 * Lists the latest captures. Unless `includeEmpty` is set, a capture that filed
 * nothing, such as a silent recording, is left out.
 */
export async function listCaptures(
	account: Account,
	limit = 50,
	{ includeEmpty = false } = {}
): Promise<CaptureView[]> {
	const filedSomething = or(
		ne(captures.status, 'done'),
		exists(
			db
				.select({ id: operations.id })
				.from(operations)
				.where(eq(operations.captureId, captures.id))
		)
	);
	const rows = await db
		.select(viewColumns)
		.from(captures)
		.where(and(eq(captures.userId, account.id), includeEmpty ? undefined : filedSomething))
		// Open questions first, so they stay in view until answered.
		.orderBy(desc(sql`${captures.status} = 'asking'`), desc(captures.createdAt))
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
