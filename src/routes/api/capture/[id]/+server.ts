import { error, json } from '@sveltejs/kit';
import { getCapture } from '#lib/server/captures.ts';
import type { RequestHandler } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns a capture, so the dashboard can tell when it has been processed. */
export const GET: RequestHandler = async ({ params }) => {
	if (!UUID.test(params.id)) error(404, 'Not found.');
	const capture = await getCapture(params.id);
	if (!capture) error(404, 'Not found.');
	return json(capture);
};
