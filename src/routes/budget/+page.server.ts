import { fail } from '@sveltejs/kit';
import type { Category, MoneyView } from '#lib/items.ts';
import { resumePendingCaptures } from '#lib/server/captures.ts';
import { listMoney } from '#lib/server/records.ts';
import {
	cleanAmount,
	cleanCategory,
	loadSettings,
	MAX_CATEGORIES,
	MAX_CATEGORY_LENGTH,
	newCategoryId,
	saveSettings
} from '#lib/server/settings.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const account = locals.account!;
	await resumePendingCaptures(account);
	const [settings, money] = await Promise.all([loadSettings(account), listMoney(account)]);
	return {
		budget: settings.budget,
		money: money.map(
			(record): MoneyView => ({
				id: record.id,
				type: record.type as MoneyView['type'],
				...record.fields,
				createdAt: record.createdAt.toISOString()
			})
		)
	};
};

export const actions: Actions = {
	// Replaces the categories and the monthly income. The form repeats `id`, `name`,
	// and `monthly` once per category, in order; a new category has an empty `id`.
	save: async ({ locals, request }) => {
		const form = await request.formData();
		const ids = form.getAll('id');
		const names = form.getAll('name');
		const amounts = form.getAll('monthly');
		if (ids.length !== names.length || ids.length !== amounts.length) {
			return fail(400, { message: 'The form was incomplete. Reload and try again.' });
		}
		if (ids.length > MAX_CATEGORIES) {
			return fail(400, { message: `A budget holds up to ${MAX_CATEGORIES} categories.` });
		}

		const categories: Category[] = [];
		for (let i = 0; i < ids.length; i++) {
			const name = String(names[i]).trim();
			const amount = String(amounts[i]).trim();
			// A row left empty is skipped, so an unused new row doesn't block saving.
			if (!name && !amount) continue;
			const id = String(ids[i]) || newCategoryId();
			const category = cleanCategory(id, name, amount || '0');
			if (!category) {
				return fail(400, {
					message: name
						? `Check “${name}”: give a name up to ${MAX_CATEGORY_LENGTH} characters and an amount of 0 or more.`
						: 'Give every category a name.'
				});
			}
			if (categories.some((other) => other.name.toLowerCase() === category.name.toLowerCase())) {
				return fail(400, { message: `“${category.name}” is listed twice.` });
			}
			categories.push(category);
		}

		const incomeInput = String(form.get('monthlyIncome') ?? '').trim();
		const monthlyIncome = incomeInput ? cleanAmount(incomeInput) : null;
		if (incomeInput && monthlyIncome === null) {
			return fail(400, { message: 'Monthly income must be an amount of 0 or more.' });
		}

		const settings = await loadSettings(locals.account!);
		await saveSettings(locals.account!, {
			...settings,
			budget: { ...settings.budget, categories, monthlyIncome }
		});
	}
};
