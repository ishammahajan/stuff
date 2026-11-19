import { error, json } from '@sveltejs/kit';
import {
	attachmentType,
	createCapture,
	isOpenQuestion,
	isWav,
	MAX_AUDIO_BYTES,
	MAX_FILE_BYTES,
	processInBackground
} from '#lib/server/captures.ts';
import { ITEM_TYPES, type ItemType } from '#lib/items.ts';
import type { RequestHandler } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ITEMS = 50;

/**
 * Accepts a multipart form with `localDate` (YYYY-MM-DD) and `timeZone` (an IANA
 * name), and at least one of `audio` (a WAV file) and `file` (an image or a PDF).
 * Optional fields: `replyTo`, the ID of a capture whose open question this answers;
 * `items`, comma-separated IDs of records the speaker selected; and `screen`, the
 * record type of the utility screen it was recorded on.
 * Saves the capture, starts interpreting it in the background, and responds with
 * its ID right away. Poll `GET /api/capture/{id}` to learn the outcome.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const account = locals.account!;
	const form = await request.formData();
	const audioField = form.get('audio');
	const fileField = form.get('file');
	const localDate = form.get('localDate');
	const timeZone = form.get('timeZone');

	const audioFile = audioField instanceof File ? audioField : null;
	const attached = fileField instanceof File ? fileField : null;
	if (!audioFile && !attached) error(400, 'Send a recording, a file, or both.');
	if (typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
		error(400, 'localDate must be YYYY-MM-DD.');
	}
	if (typeof timeZone !== 'string' || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(timeZone)) {
		error(400, 'timeZone must be an IANA time zone name.');
	}
	if (audioFile && audioFile.size > MAX_AUDIO_BYTES) error(413, 'The recording is too long.');
	if (attached && attached.size > MAX_FILE_BYTES) error(413, 'The file is larger than 10 MB.');

	// A reply to a question that is no longer open is filed as a plain memo.
	const replyField = form.get('replyTo');
	const replyTo =
		typeof replyField === 'string' &&
		UUID.test(replyField) &&
		(await isOpenQuestion(account, replyField))
			? replyField
			: null;

	const audio = audioFile && Buffer.from(await audioFile.arrayBuffer());
	if (audio && !isWav(audio)) error(400, 'The recording must be a WAV file.');

	let file = null;
	if (attached) {
		const data = Buffer.from(await attached.arrayBuffer());
		const type = attachmentType(data);
		if (!type) error(415, 'Only images (PNG, JPEG, WebP, HEIC) and PDFs can be sent.');
		const name = attached.name.slice(0, 200) || 'file';
		file = { data, info: { name, type } };
	}

	// Selected records, as comma-separated IDs. Ownership is checked when filing.
	const itemsField = form.get('items');
	const items = typeof itemsField === 'string' ? itemsField.split(',').filter((id) => UUID.test(id)) : [];
	if (items.length > MAX_ITEMS) error(400, `Select at most ${MAX_ITEMS} items.`);

	const screenField = form.get('screen');
	const screen = ITEM_TYPES.includes(screenField as ItemType) ? (screenField as ItemType) : null;

	const id = await createCapture(account, {
		audio,
		file,
		localDate,
		timeZone,
		replyTo,
		items,
		screen
	});
	processInBackground(account, id);
	return json({ id }, { status: 202 });
};
