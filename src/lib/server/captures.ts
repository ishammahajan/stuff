import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { CaptureView } from '../items.ts';
import { db } from './db/index.ts';
import { captures } from './db/schema.ts';
import { interpretAudio } from './openrouter.ts';

// 16 kHz mono 16-bit WAV is about 32 kB per second, so this allows roughly four minutes.
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

const viewColumns = {
	id: captures.id,
	createdAt: captures.createdAt,
	status: captures.status,
	transcript: captures.transcript,
	items: captures.items,
	error: captures.error
};

type ViewRow = Omit<CaptureView, 'items'> & { items: CaptureView['items'] | null };

function toView(row: ViewRow): CaptureView {
	return { ...row, items: row.items ?? [] };
}

export function isWav(audio: Buffer): boolean {
	return (
		audio.length > 44 &&
		audio.toString('ascii', 0, 4) === 'RIFF' &&
		audio.toString('ascii', 8, 12) === 'WAVE'
	);
}

export async function createCapture(
	audio: Buffer,
	localDate: string,
	timeZone: string
): Promise<string> {
	const [row] = await db
		.insert(captures)
		.values({ audio, localDate, timeZone })
		.returning({ id: captures.id });
	return row.id;
}

// Captures being processed by this server process, so that a retry cannot start
// a second model call for a capture that is already in progress.
const inProgress = new Set<string>();

/**
 * Runs the model over a capture's stored audio and records the outcome.
 * The audio is dropped on success and kept on failure, so a failure can be retried.
 */
export async function processCapture(id: string): Promise<void> {
	if (inProgress.has(id)) return;
	inProgress.add(id);
	try {
		await interpretCapture(id);
	} finally {
		inProgress.delete(id);
	}
}

/** Starts processing without waiting for it. Errors are logged, not thrown. */
export function processInBackground(id: string): void {
	processCapture(id).catch((error) => console.error(`Capture ${id} failed to process:`, error));
}

/**
 * Restarts processing for captures left pending, for example by a server restart
 * during a model call. Failed captures wait for a retry from the inbox.
 */
export async function resumePendingCaptures(): Promise<void> {
	const rows = await db
		.select({ id: captures.id })
		.from(captures)
		.where(and(eq(captures.status, 'pending'), isNotNull(captures.audio)));
	for (const { id } of rows) processInBackground(id);
}

async function interpretCapture(id: string): Promise<void> {
	const [capture] = await db.select().from(captures).where(eq(captures.id, id)).limit(1);
	if (!capture?.audio) return;

	try {
		const result = await interpretAudio(capture.audio, capture.localDate, capture.timeZone);
		await db
			.update(captures)
			.set({
				status: 'done',
				transcript: result.transcript,
				items: result.items,
				error: null,
				audio: null
			})
			.where(eq(captures.id, id));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db.update(captures).set({ status: 'failed', error: message }).where(eq(captures.id, id));
	}
}

export async function getCapture(id: string): Promise<CaptureView | null> {
	const [row] = await db.select(viewColumns).from(captures).where(eq(captures.id, id)).limit(1);
	return row ? toView(row) : null;
}

export async function listCaptures(limit = 50): Promise<CaptureView[]> {
	const rows = await db
		.select(viewColumns)
		.from(captures)
		.orderBy(desc(captures.createdAt))
		.limit(limit);
	return rows.map(toView);
}

export async function deleteCapture(id: string): Promise<void> {
	await db.delete(captures).where(eq(captures.id, id));
}
