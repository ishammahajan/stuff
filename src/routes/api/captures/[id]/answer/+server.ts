import { error, json } from '@sveltejs/kit';
import { answerQuestion } from '#lib/server/captures.ts';
import type { RequestHandler } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Settles a capture's open question. The JSON body is `{ option, localDate }`:
 * the index of the chosen answer, or null to dismiss the question without changing
 * anything, and the user's local date (YYYY-MM-DD).
 * Responds 409 with a message when the question is no longer open.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!UUID.test(params.id)) error(404, 'Not found.');
	const body = await request.json().catch(() => null);
	const option = body?.option;
	const localDate = body?.localDate;
	if (option !== null && !(Number.isInteger(option) && option >= 0)) {
		error(400, 'option must be an answer index or null.');
	}
	if (typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
		error(400, 'localDate must be YYYY-MM-DD.');
	}
	const problem = await answerQuestion(locals.account!, params.id, option, localDate);
	if (problem) return json({ message: problem }, { status: 409 });
	return new Response(null, { status: 204 });
};
