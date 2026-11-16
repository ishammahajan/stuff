import { error, json } from '@sveltejs/kit';
import { createCapture, isWav, MAX_AUDIO_BYTES, processCapture } from '#lib/server/captures.ts';
import type { RequestHandler } from './$types';

/**
 * Accepts a multipart form with `audio` (a WAV file), `localDate` (YYYY-MM-DD),
 * and `timeZone` (an IANA name). Saves the recording, interprets it, and returns
 * the capture.
 */
export const POST: RequestHandler = async ({ request }) => {
	const form = await request.formData();
	const file = form.get('audio');
	const localDate = form.get('localDate');
	const timeZone = form.get('timeZone');

	if (!(file instanceof File)) error(400, 'Missing audio file.');
	if (typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
		error(400, 'localDate must be YYYY-MM-DD.');
	}
	if (typeof timeZone !== 'string' || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(timeZone)) {
		error(400, 'timeZone must be an IANA time zone name.');
	}
	if (file.size > MAX_AUDIO_BYTES) error(413, 'The recording is too long.');

	const audio = Buffer.from(await file.arrayBuffer());
	if (!isWav(audio)) error(400, 'The recording must be a WAV file.');

	const id = await createCapture(audio, localDate, timeZone);
	return json(await processCapture(id));
};
