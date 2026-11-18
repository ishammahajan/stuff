import { json } from '@sveltejs/kit';
import { listCaptures, resumePendingCaptures } from '#lib/server/captures.ts';
import type { RequestHandler } from './$types';

const RECENT = 3;

/**
 * Returns the latest captures for the home screen's recent strip. Captures left
 * pending by a restart start processing again, as on the inbox.
 */
export const GET: RequestHandler = async ({ locals }) => {
	const account = locals.account!;
	await resumePendingCaptures(account);
	return json(await listCaptures(account, RECENT));
};
