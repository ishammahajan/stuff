import { resumePendingCaptures } from '#lib/server/captures.ts';
import { listTasks } from '#lib/server/records.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const account = locals.account!;
	await resumePendingCaptures(account);
	return { tasks: await listTasks(account) };
};
