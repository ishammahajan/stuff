// Voice activity detection with Silero VAD (models/silero_vad.onnx, MIT licence).
// It recognises speech rather than loudness, so a fan or traffic doesn't count.
import { resolve } from 'node:path';
import { InferenceSession, Tensor } from 'onnxruntime-node';

const MODEL_PATH = resolve('models/silero_vad.onnx');
const SAMPLE_RATE = 16_000;
// The model reads 512 new samples (32 ms) at a time, after the previous window's last 64.
const WINDOW = 512;
const CONTEXT = 64;
const WINDOW_MS = (WINDOW / SAMPLE_RATE) * 1000;

// A window is speech at this probability, and speech goes on until it falls below the
// lower one. These are the model's recommended values.
const START = 0.5;
const END = 0.35;
// Shorter bursts, such as a cough or a click, aren't speech.
const MIN_SPEECH_MS = 250;
// Pauses shorter than this stay in the recording.
const MIN_GAP_MS = 1000;
// Kept around each stretch of speech, so its first and last sounds aren't clipped.
const PAD_MS = 300;

let session: Promise<InferenceSession> | null = null;

function loadModel(): Promise<InferenceSession> {
	session ??= InferenceSession.create(MODEL_PATH, {
		intraOpNumThreads: 1,
		interOpNumThreads: 1
	}).catch((error) => {
		session = null;
		throw error;
	});
	return session;
}

interface Pcm {
	samples: Int16Array;
	/** Everything before the samples, so they can be written back as a WAV file. */
	header: Buffer;
}

/** Reads 16 kHz mono 16-bit PCM, the format the browser sends, or returns null. */
function readPcm(wav: Buffer): Pcm | null {
	let offset = 12;
	let format = false;
	while (offset + 8 <= wav.length) {
		const id = wav.toString('ascii', offset, offset + 4);
		const size = wav.readUInt32LE(offset + 4);
		const start = offset + 8;
		if (id === 'fmt ' && size >= 16) {
			format =
				wav.readUInt16LE(start) === 1 &&
				wav.readUInt16LE(start + 2) === 1 &&
				wav.readUInt32LE(start + 4) === SAMPLE_RATE &&
				wav.readUInt16LE(start + 14) === 16;
		} else if (id === 'data') {
			if (!format) return null;
			const end = Math.min(wav.length, start + size);
			const copy = wav.subarray(start, end - ((end - start) % 2));
			const samples = new Int16Array(copy.length / 2);
			for (let i = 0; i < samples.length; i++) samples[i] = copy.readInt16LE(i * 2);
			return { samples, header: wav.subarray(0, start) };
		}
		offset = start + size + (size % 2);
	}
	return null;
}

/** Returns the probability of speech for each 32 ms window. */
async function speechProbabilities(samples: Int16Array): Promise<Float32Array> {
	const model = await loadModel();
	const count = Math.floor(samples.length / WINDOW);
	const probabilities = new Float32Array(count);
	const input = new Float32Array(CONTEXT + WINDOW);
	let state: Tensor = new Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
	const sr = new Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);
	for (let w = 0; w < count; w++) {
		input.copyWithin(0, WINDOW);
		for (let i = 0; i < WINDOW; i++) input[CONTEXT + i] = samples[w * WINDOW + i] / 32768;
		const result = await model.run({
			input: new Tensor('float32', input.slice(), [1, CONTEXT + WINDOW]),
			state,
			sr
		});
		probabilities[w] = (result.output.data as Float32Array)[0];
		state = result.stateN;
	}
	return probabilities;
}

/** Finds the stretches of speech, as [start, end) sample positions. */
function speechSegments(probabilities: Float32Array, length: number): [number, number][] {
	const toWindows = (ms: number) => Math.ceil(ms / WINDOW_MS);
	const segments: [number, number][] = [];
	let start = -1;
	let quiet = 0;
	for (let w = 0; w <= probabilities.length; w++) {
		const p = w < probabilities.length ? probabilities[w] : 0;
		if (start < 0) {
			if (p >= START) {
				start = w;
				quiet = 0;
			}
			continue;
		}
		quiet = p < END ? quiet + 1 : 0;
		const ended = w === probabilities.length || quiet >= toWindows(MIN_GAP_MS);
		if (!ended) continue;
		const end = w - quiet + 1;
		if (end - start >= toWindows(MIN_SPEECH_MS)) segments.push([start, end]);
		start = -1;
	}

	// Pads each stretch and merges the ones that then overlap.
	const pad = Math.round((PAD_MS / 1000) * SAMPLE_RATE);
	const merged: [number, number][] = [];
	for (const [first, last] of segments) {
		const from = Math.max(0, first * WINDOW - pad);
		const to = Math.min(length, last * WINDOW + pad);
		const previous = merged.at(-1);
		if (previous && from <= previous[1]) previous[1] = Math.max(previous[1], to);
		else merged.push([from, to]);
	}
	return merged;
}

/**
 * Keeps only the speech in a recording, without the long pauses and noise around
 * it. Returns null when the recording has no speech. A recording in another format
 * is returned as it is.
 */
export async function keepSpeech(wav: Buffer): Promise<Buffer | null> {
	const pcm = readPcm(wav);
	if (!pcm) return wav;
	const segments = speechSegments(await speechProbabilities(pcm.samples), pcm.samples.length);
	if (segments.length === 0) return null;

	const length = segments.reduce((sum, [from, to]) => sum + (to - from), 0);
	const data = Buffer.alloc(length * 2);
	let offset = 0;
	for (const [from, to] of segments) {
		for (let i = from; i < to; i++) offset = data.writeInt16LE(pcm.samples[i], offset);
	}
	const header = Buffer.from(pcm.header);
	header.writeUInt32LE(header.length - 8 + data.length, 4);
	header.writeUInt32LE(data.length, header.length - 4);
	return Buffer.concat([header, data]);
}
