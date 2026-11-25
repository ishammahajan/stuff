import { error, json } from '@sveltejs/kit';
import { changeRecord } from '#lib/server/records.ts';
import type { RequestHandler } from './$types';

const TYPES = ['expense', 'income'] as const;

/**
 * Deletes an expense or an income record from a tap. The JSON body is
 * `{ action: 'delete', type, localDate }`. Responds with `{ operationId }`, which
 * `POST /api/operations/{id}/undo` takes, or 409 when the record is gone.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const body = await request.json().catch(() => null);
	const localDate = body?.localDate;
	if (body?.action !== 'delete') error(400, 'action must be delete.');
	if (!TYPES.includes(body?.type)) error(400, 'type must be expense or income.');
	if (typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
		error(400, 'localDate must be YYYY-MM-DD.');
	}
	const operationId = await changeRecord(locals.account!, params.id, body.type, 'delete', localDate);
	if (!operationId) return json({ message: 'That record has changed. Reload and try again.' }, { status: 409 });
	return json({ operationId });
};
