import { error, json } from '@sveltejs/kit';
import { answerQuestion } from '#lib/server/captures.ts';
import type { RequestHandler } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Settles a capture's open question. The JSON body is `{ option }`: the index of
 * the chosen answer, or null to dismiss the question without changing anything.
 * Responds 409 with a message when the question is no longer open.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!UUID.test(params.id)) error(404, 'Not found.');
	const body = await request.json().catch(() => null);
	const option = body?.option;
	if (option !== null && !(Number.isInteger(option) && option >= 0)) {
		error(400, 'option must be an answer index or null.');
	}
	const problem = await answerQuestion(locals.account!, params.id, option);
	if (problem) return json({ message: problem }, { status: 409 });
	return new Response(null, { status: 204 });
};
