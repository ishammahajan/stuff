import { error, json } from '@sveltejs/kit';
import { changeRecord } from '#lib/server/records.ts';
import type { RequestHandler } from './$types';

/**
 * Deletes a trainer note from a tap. The JSON body is `{ action: 'delete', localDate }`.
 * Responds with `{ operationId }`, which `POST /api/operations/{id}/undo` takes, or
 * 409 when the note is gone.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const body = await request.json().catch(() => null);
	const localDate = body?.localDate;
	if (body?.action !== 'delete') error(400, 'action must be delete.');
	if (typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
		error(400, 'localDate must be YYYY-MM-DD.');
	}
	const operationId = await changeRecord(locals.account!, params.id, 'trainer_note', 'delete', localDate);
	if (!operationId) return json({ message: 'That note has changed. Reload and try again.' }, { status: 409 });
	return json({ operationId });
};
