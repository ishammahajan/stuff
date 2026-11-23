import { fail } from '@sveltejs/kit';
import {
	cleanName,
	loadSettings,
	MAX_NAME_LENGTH,
	MAX_NAMES,
	saveSettings
} from '#lib/server/settings.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const settings = await loadSettings(locals.account!);
	return { names: settings.names };
};

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const actions: Actions = {
	// Adds one name, or several separated by commas or new lines.
	addNames: async ({ locals, request }) => {
		const form = await request.formData();
		const input = String(form.get('names') ?? '');
		const added: string[] = [];
		for (const part of input.split(/[,\n]/)) {
			if (!part.trim()) continue;
			const name = cleanName(part);
			if (!name) return fail(400, { message: `A name can be up to ${MAX_NAME_LENGTH} characters.`, input });
			added.push(name);
		}
		if (added.length === 0) return fail(400, { message: 'Type a name first.', input });

		const settings = await loadSettings(locals.account!);
		const names = [...settings.names];
		for (const name of added) {
			// A new spelling of a name already on the list replaces the old one.
			const index = names.findIndex((existing) => sameName(existing, name));
			if (index >= 0) names[index] = name;
			else names.push(name);
		}
		if (names.length > MAX_NAMES) {
			return fail(400, { message: `The list holds up to ${MAX_NAMES} names.`, input });
		}
		names.sort((a, b) => a.localeCompare(b));
		await saveSettings(locals.account!, { ...settings, names });
	},
	removeName: async ({ locals, request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '');
		const settings = await loadSettings(locals.account!);
		await saveSettings(locals.account!, {
			...settings,
			names: settings.names.filter((existing) => existing !== name)
		});
	}
};
