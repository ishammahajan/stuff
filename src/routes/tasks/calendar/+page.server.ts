import { createFeed, deleteFeed, DUE_HOUR, hasFeed } from '#lib/server/calendar.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	return { connected: await hasFeed(locals.account!), dueHour: DUE_HOUR };
};

export const actions: Actions = {
	// Makes a new link. Any earlier link stops working.
	create: async ({ locals, url }) => {
		const token = await createFeed(locals.account!);
		const link = `${url.origin}/calendar/${token}.ics`;
		return { link, webcal: link.replace(/^https?:/, 'webcal:') };
	},
	delete: async ({ locals }) => {
		await deleteFeed(locals.account!);
	}
};
