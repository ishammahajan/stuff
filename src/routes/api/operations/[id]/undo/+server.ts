import { error, json } from '@sveltejs/kit';
import { refreshFeedQuietly } from '#lib/server/calendar.ts';
import { undoOperation } from '#lib/server/records.ts';
import type { RequestHandler } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Undoes one operation. Responds 409 with a message when it can't be undone. */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!UUID.test(params.id)) error(404, 'Not found.');
	const problem = await undoOperation(locals.account!, params.id);
	if (problem) return json({ message: problem }, { status: 409 });
	await refreshFeedQuietly(locals.account!);
	return new Response(null, { status: 204 });
};
