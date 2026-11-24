// The knowledge base: the text of uploaded PDFs, kept in passages beside their note,
// and search by meaning over notes and those passages. Embeddings are computed on
// this server (embeddings.ts) and stored encrypted, so searches compare them in
// memory after decryption.
import { createHash, randomUUID } from 'node:crypto';
import { and, count, eq } from 'drizzle-orm';
import { extractText, getDocumentProxy } from 'unpdf';
import type { Account } from './auth.ts';
import { decrypt, decryptJson, encrypt, encryptJson } from './crypto.ts';
import { db } from './db/index.ts';
import { passages } from './db/schema.ts';
import {
	embeddingFromBytes,
	embeddingToBytes,
	embedPassage,
	embedQuery,
	similarity
} from './embeddings.ts';
import type { StoredRecord, Transaction } from './records.ts';

const bodyContext = (id: string) => `passages:${id}:body`;
const embeddingContext = (id: string) => `passages:${id}:embedding`;

// A passage is about 200 words, which fits the embedding model's 512 tokens, and
// repeats the last 40 words of the one before so a sentence cut in two is still found.
const PASSAGE_WORDS = 200;
const OVERLAP_WORDS = 40;
// About 300,000 words. A longer document keeps its beginning.
const MAX_PASSAGES = 1500;
// A PDF with less text than this is most likely scanned, with no text layer.
const MIN_TEXT_CHARS = 200;
const RESULTS = 8;

/** A passage of a document's text, before it is stored. */
export interface DocumentPassage {
	text: string;
	/** The page the passage starts on, from 1. */
	page: number;
	embedding: Float32Array;
}

/** The text of a PDF by page, or null when it has too little text to keep. */
export async function pdfPages(data: Buffer): Promise<string[] | null> {
	const pdf = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 });
	const { text } = await extractText(pdf, { mergePages: false });
	const pages = text.map((page) => page.replace(/\s+/g, ' ').trim());
	return pages.join('').length >= MIN_TEXT_CHARS ? pages : null;
}

/** Splits pages of text into overlapping passages and embeds each one. */
export async function documentPassages(pages: string[]): Promise<DocumentPassage[]> {
	const words: { word: string; page: number }[] = [];
	pages.forEach((text, i) => {
		for (const word of text.split(' ')) if (word) words.push({ word, page: i + 1 });
	});
	const result: DocumentPassage[] = [];
	const step = PASSAGE_WORDS - OVERLAP_WORDS;
	for (let start = 0; start < words.length && result.length < MAX_PASSAGES; start += step) {
		const slice = words.slice(start, start + PASSAGE_WORDS);
		const text = slice.map(({ word }) => word).join(' ');
		result.push({ text, page: slice[0].page, embedding: await embedPassage(text) });
		if (start + PASSAGE_WORDS >= words.length) break;
	}
	return result;
}

/** Stores a document's passages with its note, inside the caller's transaction. */
export async function storePassages(
	tx: Transaction,
	account: Account,
	recordId: string,
	document: DocumentPassage[]
): Promise<void> {
	const rows = document.map((passage, position) => {
		const id = randomUUID();
		return {
			id,
			userId: account.id,
			recordId,
			kind: 'document' as const,
			position,
			body: encryptJson(account.key, { text: passage.text, page: passage.page }, bodyContext(id)),
			embedding: encrypt(account.key, embeddingToBytes(passage.embedding), embeddingContext(id))
		};
	});
	// Inserted in batches, because Postgres takes a limited number of parameters.
	for (let i = 0; i < rows.length; i += 200) {
		await tx.insert(passages).values(rows.slice(i, i + 200));
	}
}

/** The text of a note that search by meaning compares. */
function noteText(record: StoredRecord): string {
	const { title, details, list, tags } = record.fields;
	return [title, details, list && `List: ${list}`, tags.length && `Tags: ${tags.join(', ')}`]
		.filter(Boolean)
		.join('\n');
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

interface LoadedPassage {
	id: string;
	recordId: string;
	kind: 'note' | 'document';
	body: { text?: string; page?: number; hash?: string };
	embedding: Float32Array;
}

/** Loads and decrypts all of the account's passages. */
async function loadPassages(account: Account): Promise<LoadedPassage[]> {
	const rows = await db.select().from(passages).where(eq(passages.userId, account.id));
	return rows.map((row) => ({
		id: row.id,
		recordId: row.recordId,
		kind: row.kind,
		body: decryptJson(account.key, row.body, bodyContext(row.id)),
		embedding: embeddingFromBytes(decrypt(account.key, row.embedding, embeddingContext(row.id)))
	}));
}

/**
 * Makes sure every note has an embedding of its current text, embedding new and
 * changed notes now. Notes are embedded when a search first needs them, because the
 * key is only held during a request, and this also covers notes saved before
 * search by meaning existed.
 */
async function noteEmbeddings(
	account: Account,
	notes: StoredRecord[],
	loaded: LoadedPassage[]
): Promise<Map<string, Float32Array>> {
	const existing = new Map(
		loaded.filter((passage) => passage.kind === 'note').map((p) => [p.recordId, p])
	);
	const vectors = new Map<string, Float32Array>();
	for (const note of notes) {
		const text = noteText(note);
		const digest = hash(text);
		const stored = existing.get(note.id);
		if (stored?.body.hash === digest) {
			vectors.set(note.id, stored.embedding);
			continue;
		}
		const embedding = await embedPassage(text);
		const id = stored?.id ?? randomUUID();
		const values = {
			body: encryptJson(account.key, { hash: digest }, bodyContext(id)),
			embedding: encrypt(account.key, embeddingToBytes(embedding), embeddingContext(id))
		};
		if (stored) {
			await db
				.update(passages)
				.set(values)
				.where(and(eq(passages.id, id), eq(passages.userId, account.id)));
		} else {
			await db
				.insert(passages)
				.values({ id, userId: account.id, recordId: note.id, kind: 'note', position: 0, ...values });
		}
		vectors.set(note.id, embedding);
	}
	return vectors;
}

/**
 * Finds the notes and document passages closest in meaning to a query, best first.
 * `summarize` turns a note into the short form the model reads.
 */
export async function searchKnowledge(
	account: Account,
	all: StoredRecord[],
	query: string,
	summarize: (record: StoredRecord) => object
) {
	const notes = all.filter((record) => record.type === 'note');
	const byId = new Map(notes.map((note) => [note.id, note]));
	const loaded = await loadPassages(account);
	const vectors = await noteEmbeddings(account, notes, loaded);
	const target = await embedQuery(query);

	const scored = [
		...[...vectors].map(([recordId, embedding]) => ({
			score: similarity(target, embedding),
			recordId,
			passage: null as LoadedPassage | null
		})),
		...loaded
			.filter((passage) => passage.kind === 'document' && byId.has(passage.recordId))
			.map((passage) => ({
				score: similarity(target, passage.embedding),
				recordId: passage.recordId,
				passage
			}))
	].sort((a, b) => b.score - a.score);

	return scored.slice(0, RESULTS).map(({ score, recordId, passage }) => {
		const note = byId.get(recordId)!;
		const relevance = Math.round(score * 100) / 100;
		return passage
			? {
					documentOf: { id: note.id, title: note.fields.title },
					page: passage.body.page,
					text: passage.body.text,
					relevance
				}
			: { note: summarize(note), relevance };
	});
}

/** The IDs of the notes that keep a document's text, with their passage counts. */
export async function documentCounts(account: Account): Promise<Map<string, number>> {
	const rows = await db
		.select({ recordId: passages.recordId, count: count() })
		.from(passages)
		.where(and(eq(passages.userId, account.id), eq(passages.kind, 'document')))
		.groupBy(passages.recordId);
	return new Map(rows.map((row) => [row.recordId, row.count]));
}
