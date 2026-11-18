import { error, json } from '@sveltejs/kit';
import {
	createCapture,
	isOpenQuestion,
	isWav,
	MAX_AUDIO_BYTES,
	processInBackground
} from '#lib/server/captures.ts';
import type { RequestHandler } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accepts a multipart form with `audio` (a WAV file), `localDate` (YYYY-MM-DD),
 * and `timeZone` (an IANA name), and optionally `replyTo`: the ID of a capture
 * whose open question this recording answers. Saves the recording, starts
 * interpreting it in the background, and responds with the new capture's ID right
 * away. Poll `GET /api/capture/{id}` to learn the outcome.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const account = locals.account!;
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

	// A reply to a question that is no longer open is filed as a plain memo.
	const replyField = form.get('replyTo');
	const replyTo =
		typeof replyField === 'string' &&
		UUID.test(replyField) &&
		(await isOpenQuestion(account, replyField))
			? replyField
			: null;

	const audio = Buffer.from(await file.arrayBuffer());
	if (!isWav(audio)) error(400, 'The recording must be a WAV file.');

	const id = await createCapture(account, audio, localDate, timeZone, replyTo);
	processInBackground(account, id);
	return json({ id }, { status: 202 });
};
