import { error, json } from '@sveltejs/kit';
import { refreshFeedQuietly } from '#lib/server/calendar.ts';
import { changeTask } from '#lib/server/records.ts';
import type { RequestHandler } from './$types';

const ACTIONS = ['complete', 'reopen', 'delete'] as const;
type Action = (typeof ACTIONS)[number];

/**
 * Completes, reopens, or deletes a task from a tap. The JSON body is
 * `{ action, localDate }`. Responds with `{ operationId }`, which
 * `POST /api/operations/{id}/undo` takes, or 409 when the task is gone or already
 * in that state.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const body = await request.json().catch(() => null);
	const action = body?.action;
	const localDate = body?.localDate;
	if (!ACTIONS.includes(action)) error(400, 'action must be complete, reopen, or delete.');
	if (typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
		error(400, 'localDate must be YYYY-MM-DD.');
	}
	const operationId = await changeTask(locals.account!, params.id, action as Action, localDate);
	if (!operationId) return json({ message: 'That task has changed. Reload and try again.' }, { status: 409 });
	await refreshFeedQuietly(locals.account!);
	return json({ operationId });
};
