import { fail } from '@sveltejs/kit';
import {
	deleteCapture,
	listCaptures,
	processCapture,
	resumePendingCaptures
} from '#lib/server/captures.ts';
import { refreshFeedQuietly } from '#lib/server/calendar.ts';
import { undoOperation } from '#lib/server/records.ts';
import type { Actions, PageServerLoad } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function captureId(request: Request): Promise<string | null> {
	const id = (await request.formData()).get('id');
	return typeof id === 'string' && UUID.test(id) ? id : null;
}

export const load: PageServerLoad = async ({ locals }) => {
	const account = locals.account!;
	await resumePendingCaptures(account);
	return { captures: await listCaptures(account) };
};

export const actions: Actions = {
	retry: async ({ request, locals }) => {
		const id = await captureId(request);
		if (!id) return fail(400);
		await processCapture(locals.account!, id);
	},
	undo: async ({ request, locals }) => {
		const id = await captureId(request);
		if (!id) return fail(400);
		const problem = await undoOperation(locals.account!, id);
		if (problem) return fail(409, { message: problem });
		await refreshFeedQuietly(locals.account!);
	},
	delete: async ({ request, locals }) => {
		const id = await captureId(request);
		if (!id) return fail(400);
		await deleteCapture(locals.account!, id);
	}
};
