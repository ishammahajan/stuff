import { error, json } from '@sveltejs/kit';
import { changeRecord, settleShare } from '#lib/server/records.ts';
import type { RequestHandler } from './$types';

const TYPES = ['expense', 'income'] as const;

/**
 * Changes an expense or an income record from a tap. The JSON body is either
 * `{ action: 'delete', type, localDate }`, or `{ action: 'settle', share, person,
 * localDate }` to mark the expense's share at index `share`, owed by `person`, as
 * paid back. Responds with `{ operationId }`, which `POST /api/operations/{id}/undo`
 * takes, or 409 when the record or the share has changed.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const body = await request.json().catch(() => null);
	const localDate = body?.localDate;
	if (typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
		error(400, 'localDate must be YYYY-MM-DD.');
	}
	let operationId: string | null;
	if (body?.action === 'delete') {
		if (!TYPES.includes(body?.type)) error(400, 'type must be expense or income.');
		operationId = await changeRecord(locals.account!, params.id, body.type, 'delete', localDate);
	} else if (body?.action === 'settle') {
		if (!Number.isInteger(body?.share) || body.share < 0) error(400, 'share must be an index.');
		if (typeof body?.person !== 'string') error(400, 'person must be a name.');
		operationId = await settleShare(locals.account!, params.id, body.share, body.person, localDate);
	} else {
		error(400, 'action must be delete or settle.');
	}
	if (!operationId) return json({ message: 'That record has changed. Reload and try again.' }, { status: 409 });
	return json({ operationId });
};
