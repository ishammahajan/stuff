// Text embeddings for search by meaning, computed on this server with
// bge-small-en-v1.5 (models/bge-small-en-v1.5, fetched by scripts/fetch-models.ts),
// so the text never leaves it. Each text becomes 384 numbers of unit length, and
// texts with similar meaning get a high dot product.
// No SvelteKit imports, so scripts can use it.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { InferenceSession, Tensor } from 'onnxruntime-node';

const DIR = resolve('models/bge-small-en-v1.5');
export const DIMENSIONS = 384;
// The model reads at most 512 tokens, including the two markers around the text.
const MAX_TOKENS = 512;
// bge models find passages best when the query, and only the query, starts with this.
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

interface Model {
	session: InferenceSession;
	vocab: Map<string, number>;
}

let model: Promise<Model> | null = null;

function loadModel(): Promise<Model> {
	model ??= (async () => {
		const [session, tokenizer] = await Promise.all([
			InferenceSession.create(`${DIR}/model_quantized.onnx`, {
				intraOpNumThreads: 1,
				interOpNumThreads: 1
			}),
			readFile(`${DIR}/tokenizer.json`, 'utf8')
		]);
		const vocab: Record<string, number> = JSON.parse(tokenizer).model.vocab;
		return { session, vocab: new Map(Object.entries(vocab)) };
	})().catch((error) => {
		model = null;
		throw error;
	});
	return model;
}

const isControl = (char: string) => /[\p{Cc}\p{Cf}]/u.test(char) && !/[\t\n\r]/.test(char);
const isPunctuation = (char: string) => {
	const code = char.codePointAt(0)!;
	// BERT counts every non-letter, non-digit ASCII symbol as punctuation.
	if ((code >= 33 && code <= 47) || (code >= 58 && code <= 64)) return true;
	if ((code >= 91 && code <= 96) || (code >= 123 && code <= 126)) return true;
	return /\p{P}/u.test(char);
};
const isCjk = (code: number) =>
	(code >= 0x4e00 && code <= 0x9fff) ||
	(code >= 0x3400 && code <= 0x4dbf) ||
	(code >= 0x20000 && code <= 0x2a6df) ||
	(code >= 0x2a700 && code <= 0x2ceaf) ||
	(code >= 0xf900 && code <= 0xfaff) ||
	(code >= 0x2f800 && code <= 0x2fa1f);

/**
 * Splits text into words the way BERT's tokenizer does: drops control characters,
 * lowercases, strips accents, and makes each punctuation mark and CJK character its
 * own word.
 */
function basicWords(text: string): string[] {
	let cleaned = '';
	for (const char of text) {
		const code = char.codePointAt(0)!;
		if (code === 0 || code === 0xfffd || isControl(char)) continue;
		if (/\s/u.test(char)) cleaned += ' ';
		else if (isCjk(code)) cleaned += ` ${char} `;
		else cleaned += char;
	}
	const normalized = cleaned.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
	const words: string[] = [];
	for (const chunk of normalized.split(' ')) {
		let word = '';
		for (const char of chunk) {
			if (isPunctuation(char)) {
				if (word) words.push(word);
				words.push(char);
				word = '';
			} else {
				word += char;
			}
		}
		if (word) words.push(word);
	}
	return words;
}

/** Splits a word into the longest vocabulary pieces, or returns the unknown token. */
function wordPieces(word: string, vocab: Map<string, number>): number[] {
	const unknown = [vocab.get('[UNK]')!];
	const chars = [...word];
	if (chars.length > 100) return unknown;
	const ids: number[] = [];
	let start = 0;
	while (start < chars.length) {
		let end = chars.length;
		let id: number | undefined;
		while (start < end) {
			const piece = (start > 0 ? '##' : '') + chars.slice(start, end).join('');
			id = vocab.get(piece);
			if (id !== undefined) break;
			end--;
		}
		if (id === undefined) return unknown;
		ids.push(id);
		start = end;
	}
	return ids;
}

/** Token IDs for a text, with the start and end markers, cut to what the model reads. */
export async function tokenize(text: string): Promise<number[]> {
	const { vocab } = await loadModel();
	const ids = basicWords(text).flatMap((word) => wordPieces(word, vocab));
	return [vocab.get('[CLS]')!, ...ids.slice(0, MAX_TOKENS - 2), vocab.get('[SEP]')!];
}

async function embed(text: string): Promise<Float32Array> {
	const { session } = await loadModel();
	const ids = await tokenize(text);
	const shape = [1, ids.length];
	const tensor = (values: number[]) =>
		new Tensor('int64', BigInt64Array.from(values, (value) => BigInt(value)), shape);
	const output = await session.run({
		input_ids: tensor(ids),
		attention_mask: tensor(ids.map(() => 1)),
		token_type_ids: tensor(ids.map(() => 0))
	});
	// bge uses the first token's state, scaled to unit length.
	const vector = (output.last_hidden_state.data as Float32Array).slice(0, DIMENSIONS);
	const norm = Math.hypot(...vector);
	return vector.map((value) => value / norm);
}

/** Embeds a stored passage or note. */
export const embedPassage = (text: string) => embed(text);

/** Embeds a search query. */
export const embedQuery = (query: string) => embed(QUERY_PREFIX + query);

/** How alike two embeddings are, from -1 to 1. Both must have unit length. */
export function similarity(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < DIMENSIONS; i++) sum += a[i] * b[i];
	return sum;
}

/** An embedding as bytes, for storing. */
export const embeddingToBytes = (vector: Float32Array) =>
	Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

/** An embedding from stored bytes. */
export function embeddingFromBytes(bytes: Buffer): Float32Array {
	// Copied, because a Float32Array needs an aligned buffer.
	return new Float32Array(new Uint8Array(bytes).buffer);
}
