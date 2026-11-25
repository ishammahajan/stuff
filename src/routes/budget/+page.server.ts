import { fail } from '@sveltejs/kit';
import type { Category, MoneyView } from '#lib/items.ts';
import { resumePendingCaptures } from '#lib/server/captures.ts';
import {
	currentBalance,
	deleteRule,
	importStatement,
	listReview,
	resolveReview,
	type ReviewChoice
} from '#lib/server/imports.ts';
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
import { readGrid, SpreadsheetError } from '#lib/server/spreadsheet.ts';
import { parseStatement, StatementError } from '#lib/server/statements.ts';
import type { Actions, PageServerLoad } from './$types';

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Generous for a year of statement rows.
const MAX_STATEMENT_BYTES = 5 * 1024 * 1024;
const MAX_STATEMENT_ROWS = 3000;

export const load: PageServerLoad = async ({ locals }) => {
	const account = locals.account!;
	await resumePendingCaptures(account);
	const [settings, money] = await Promise.all([loadSettings(account), listMoney(account)]);
	return {
		budget: settings.budget,
		review: await listReview(account, money),
		balance: await currentBalance(account, money, settings.budget),
		money: money.map((record): MoneyView => ({
			id: record.id,
			type: record.type as MoneyView['type'],
			...record.fields,
			createdAt: record.createdAt.toISOString()
		}))
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
			return fail(400, {
				message: 'The form was incomplete. Reload and try again.'
			});
		}
		if (ids.length > MAX_CATEGORIES) {
			return fail(400, {
				message: `A budget holds up to ${MAX_CATEGORIES} categories.`
			});
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
			return fail(400, {
				message: 'Monthly income must be an amount of 0 or more.'
			});
		}

		const settings = await loadSettings(locals.account!);
		await saveSettings(locals.account!, {
			...settings,
			budget: { ...settings.budget, categories, monthlyIncome }
		});
	},

	// Imports a bank statement file (`statement`). It is parsed here and never stored.
	import: async ({ locals, request }) => {
		const form = await request.formData();
		const file = form.get('statement');
		const today = form.get('localDate');
		if (typeof today !== 'string' || !LOCAL_DATE.test(today)) {
			return fail(400, {
				message: 'The form was incomplete. Reload and try again.'
			});
		}
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { message: 'Choose a statement file.' });
		}
		if (file.size > MAX_STATEMENT_BYTES) {
			return fail(400, { message: 'That file is too large for a statement.' });
		}
		let statement;
		try {
			statement = parseStatement(readGrid(Buffer.from(await file.arrayBuffer())));
		} catch (err) {
			if (err instanceof SpreadsheetError || err instanceof StatementError) {
				return fail(400, { message: err.message });
			}
			throw err;
		}
		if (statement.rows.length > MAX_STATEMENT_ROWS) {
			return fail(400, {
				message: `A statement can hold up to ${MAX_STATEMENT_ROWS} rows. Download a shorter period.`
			});
		}
		return { imported: await importStatement(locals.account!, statement, today) };
	},

	// Settles rows in review: `ids` repeats once per row, and `choice` is `ignore`,
	// `income`, `category:<id>`, or `merge:<expense id>`.
	review: async ({ locals, request }) => {
		const form = await request.formData();
		const ids = form.getAll('ids').map(String);
		const choiceText = String(form.get('choice') ?? '');
		const today = form.get('localDate');
		if (typeof today !== 'string' || !LOCAL_DATE.test(today) || ids.length === 0) {
			return fail(400, {
				message: 'The form was incomplete. Reload and try again.'
			});
		}
		let choice: ReviewChoice;
		const [kind, value] = choiceText.split(':');
		if (kind === 'ignore' || kind === 'income') choice = { action: kind };
		else if (kind === 'category' && value) choice = { action: 'category', category: value };
		else if (kind === 'merge' && value) choice = { action: 'merge', recordId: value };
		else return fail(400, { message: 'Choose what these are.' });
		const problem = await resolveReview(locals.account!, ids, choice, today);
		if (problem) return fail(409, { message: problem });
	},

	// Removes a statement rule by its `id`.
	deleteRule: async ({ locals, request }) => {
		const form = await request.formData();
		await deleteRule(locals.account!, String(form.get('id') ?? ''));
	}
};
