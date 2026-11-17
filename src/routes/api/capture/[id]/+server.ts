import { error, json } from '@sveltejs/kit';
import { getCapture, processInBackground } from '#lib/server/captures.ts';
import type { RequestHandler } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns a capture, so the dashboard can tell when it has been processed.
 * A capture still pending here may have been interrupted by a restart, so this
 * also starts processing again; that does nothing if it is already running.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const account = locals.account!;
	if (!UUID.test(params.id)) error(404, 'Not found.');
	const capture = await getCapture(account, params.id);
	if (!capture) error(404, 'Not found.');
	if (capture.status === 'pending') processInBackground(account, capture.id);
	return json(capture);
};
