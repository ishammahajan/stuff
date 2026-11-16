// Browser-side audio helpers.

const SAMPLE_RATE = 16_000;

/**
 * Converts a recording in whatever format the browser produced into 16 kHz mono
 * 16-bit WAV, which every speech model accepts.
 */
export async function toWav(recording: Blob): Promise<Blob> {
	const context = new AudioContext();
	let decoded: AudioBuffer;
	try {
		decoded = await context.decodeAudioData(await recording.arrayBuffer());
	} finally {
		await context.close();
	}

	// Rendering through an offline context resamples and mixes down to mono.
	const frames = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
	const offline = new OfflineAudioContext(1, frames, SAMPLE_RATE);
	const source = offline.createBufferSource();
	source.buffer = decoded;
	source.connect(offline.destination);
	source.start();
	const samples = (await offline.startRendering()).getChannelData(0);

	const dataBytes = samples.length * 2;
	const view = new DataView(new ArrayBuffer(44 + dataBytes));
	const writeAscii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};

	writeAscii(0, 'RIFF');
	view.setUint32(4, 36 + dataBytes, true);
	writeAscii(8, 'WAVE');
	writeAscii(12, 'fmt ');
	view.setUint32(16, 16, true); // format chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // channels
	view.setUint32(24, SAMPLE_RATE, true);
	view.setUint32(28, SAMPLE_RATE * 2, true); // bytes per second
	view.setUint16(32, 2, true); // bytes per frame
	view.setUint16(34, 16, true); // bits per sample
	writeAscii(36, 'data');
	view.setUint32(40, dataBytes, true);

	for (let i = 0; i < samples.length; i++) {
		const sample = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
	}

	return new Blob([view], { type: 'audio/wav' });
}
