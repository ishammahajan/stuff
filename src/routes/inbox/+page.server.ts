import { fail } from '@sveltejs/kit';
import { deleteCapture, listCaptures, processCapture } from '#lib/server/captures.ts';
import type { Actions, PageServerLoad } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function captureId(request: Request): Promise<string | null> {
	const id = (await request.formData()).get('id');
	return typeof id === 'string' && UUID.test(id) ? id : null;
}

export const load: PageServerLoad = async () => {
	return { captures: await listCaptures() };
};

export const actions: Actions = {
	retry: async ({ request }) => {
		const id = await captureId(request);
		if (!id) return fail(400);
		await processCapture(id);
	},
	delete: async ({ request }) => {
		const id = await captureId(request);
		if (!id) return fail(400);
		await deleteCapture(id);
	}
};
