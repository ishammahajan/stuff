import { error, json } from '@sveltejs/kit';
import type { SetValues } from '#lib/items.ts';
import { changeRecord, logSet } from '#lib/server/records.ts';
import type { RequestHandler } from './$types';

const ACTIONS = ['log', 'complete', 'reopen', 'delete'] as const;
type Action = (typeof ACTIONS)[number];

/** A logged number, or null when left empty. Anything else is a bad request. */
function value(raw: unknown, max: number): number | null {
	if (raw === null || raw === undefined || raw === '') return null;
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > max) {
		error(400, 'Set values must be numbers in range.');
	}
	return Math.round(raw * 100) / 100;
}

/** The set values in a `log` request, or null to clear the set. */
function parseDone(raw: unknown): SetValues | null {
	if (raw === null) return null;
	if (typeof raw !== 'object') error(400, 'done must be an object or null.');
	const { weight, reps, seconds } = raw as Record<string, unknown>;
	const done = { weight: value(weight, 1000), reps: value(reps, 1000), seconds: value(seconds, 36_000) };
	if (done.weight === null && done.reps === null && done.seconds === null) {
		error(400, 'Enter at least one value for the set.');
	}
	return done;
}

/**
 * Changes a workout from a tap. The JSON body is `{ action, localDate }`, and for
 * `log` also `{ exercise, name, set, done }`: the exercise's index and name, the
 * set's index (one past the last adds a set), and the values done, or null to clear
 * the set. Responds with `{ operationId }`, which `POST /api/operations/{id}/undo`
 * takes, or 409 when the workout changed.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const body = await request.json().catch(() => null);
	const action = body?.action as Action;
	const localDate = body?.localDate;
	if (!ACTIONS.includes(action)) error(400, 'action must be log, complete, reopen, or delete.');
	if (typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
		error(400, 'localDate must be YYYY-MM-DD.');
	}
	const account = locals.account!;
	let operationId: string | null;
	if (action === 'log') {
		const { exercise, name, set } = body;
		if (!Number.isInteger(exercise) || !Number.isInteger(set) || typeof name !== 'string') {
			error(400, 'log needs exercise, name, and set.');
		}
		operationId = await logSet(account, params.id, exercise, name, set, parseDone(body.done), localDate);
	} else {
		operationId = await changeRecord(account, params.id, 'workout', action, localDate);
	}
	if (!operationId) {
		return json({ message: 'That workout has changed. Reload and try again.' }, { status: 409 });
	}
	return json({ operationId });
};
