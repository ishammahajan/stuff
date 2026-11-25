// Imports bank statements into the budget. Rows are filed by the user's rules or
// matched to an expense recorded by voice; the rest wait in review. No statement
// row is ever sent to the model.
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
	withDefaults,
	type BalanceView,
	type Budget,
	type ReviewRow,
	type StatementRule
} from '../items.ts';
import type { Account } from './auth.ts';
import { decryptJson, encryptJson } from './crypto.ts';
import { db } from './db/index.ts';
import { records, statementRows, users } from './db/schema.ts';
import {
	applyOperations,
	listMoney,
	type ProposedOperation,
	type StoredRecord,
	type Transaction
} from './records.ts';
import { loadSettings, newCategoryId, saveSettings } from './settings.ts';
import { isCardPayment, type Statement, type StatementRow } from './statements.ts';

/** What became of a statement row. */
type Outcome =
	/** A new expense or income record. */
	| 'record'
	/** An expense already recorded by voice. */
	| 'merged'
	/** Not spending or not income, by the user's choice or rule. */
	| 'ignored'
	/** A credit card bill payment, between the user's own accounts. */
	| 'transfer';

/** The encrypted part of a statement row. */
interface StatementRowBody {
	key: string;
	/** The transaction, kept only while it waits in review. */
	row?: StatementRow;
	/** IDs of expenses the row may be, while it waits in review. */
	candidates?: string[];
	outcome?: Outcome;
	/** The record it became or was merged into. */
	recordId?: string;
	/** A transfer's day and amount, to count a card bill paid after the card's statement. */
	date?: string;
	amount?: number;
}

export interface ImportResult {
	added: number;
	merged: number;
	ignored: number;
	review: number;
	/** Rows imported before, from an earlier statement. */
	known: number;
}

const bodyContext = (id: string) => `statement_rows:${id}:body`;

// A statement row and an expense recorded by voice are the same when the amounts
// match and their dates are at most this many days apart.
const MERGE_DAYS = 3;
const DAY = 24 * 60 * 60 * 1000;

const cents = (value: number) => Math.round(value * 100);

/** Waits for the account's other imports and reviews, so two never interleave. */
async function lockAccount(tx: Transaction, account: Account) {
	await tx.select({ id: users.id }).from(users).where(eq(users.id, account.id)).for('update');
}

async function loadRows(tx: Transaction, account: Account, status?: 'review' | 'done') {
	const rows = await tx
		.select()
		.from(statementRows)
		.where(
			status
				? and(eq(statementRows.userId, account.id), eq(statementRows.status, status))
				: eq(statementRows.userId, account.id)
		);
	return rows.map((row) => ({
		id: row.id,
		status: row.status,
		createdAt: row.createdAt,
		body: decryptJson<StatementRowBody>(account.key, row.body, bodyContext(row.id))
	}));
}

function insertRow(tx: Transaction, account: Account, body: StatementRowBody) {
	const id = randomUUID();
	return tx.insert(statementRows).values({
		id,
		userId: account.id,
		status: body.row ? 'review' : 'done',
		body: encryptJson(account.key, body, bodyContext(id))
	});
}

/** The rule for a row, if one matches and still makes sense. */
export function findRule(budget: Budget, row: StatementRow): StatementRule | null {
	if (!row.payee) return null;
	const rule = budget.rules.find(
		(rule) =>
			rule.direction === row.direction &&
			rule.payee.toLowerCase() === row.payee.toLowerCase() &&
			(rule.vpa ?? '').toLowerCase() === (row.vpa ?? '').toLowerCase()
	);
	if (!rule) return null;
	if (rule.action === 'category' && !budget.categories.some((c) => c.id === rule.category))
		return null;
	return rule;
}

/** The record a statement row becomes. */
function createFor(row: StatementRow, category: string | null): ProposedOperation {
	const title = row.payee || (row.account === 'card' ? 'Card payment' : 'Bank transaction');
	return {
		action: 'create',
		type: row.direction === 'debit' ? 'expense' : 'income',
		recordId: randomUUID(),
		fields: withDefaults({
			title,
			amount: row.amount,
			date: row.date,
			category
		})
	};
}

/** An expense's day: its own date, or the day it was recorded. */
const expenseDay = (record: StoredRecord) =>
	Date.parse(record.fields.date ?? record.createdAt.toISOString().slice(0, 10));

/**
 * Imports a parsed statement. Rows imported before are skipped. A card bill
 * payment is a transfer. Money out that matches exactly one expense recorded by
 * voice is merged into it, and with more than one it waits in review. Otherwise a
 * rule files the row, or it waits in review. The statement's balance replaces the
 * stored one when the statement is the later of the two.
 */
export async function importStatement(
	account: Account,
	{ account: kind, rows, balance }: Statement,
	today: string
): Promise<ImportResult> {
	const [settings, money] = await Promise.all([loadSettings(account), listMoney(account)]);
	const result: ImportResult = {
		added: 0,
		merged: 0,
		ignored: 0,
		review: 0,
		known: 0
	};
	// Keys of rows this import added.
	const added = new Set<string>();
	await db.transaction(async (tx) => {
		await lockAccount(tx, account);
		const existing = await loadRows(tx, account);
		const known = new Set(existing.map((row) => row.body.key));
		// Expenses a statement row already became or was merged into.
		const linked = new Set(
			existing.flatMap((row) => (row.body.recordId ? [row.body.recordId] : []))
		);
		// Expenses that a row in review may be, which another row mustn't take.
		const contested = new Set(existing.flatMap((row) => row.body.candidates ?? []));
		const voiceExpenses = money.filter(
			(record) =>
				record.type === 'expense' &&
				!linked.has(record.id) &&
				record.fields.amount !== null &&
				(record.fields.currency ?? settings.budget.currency) === settings.budget.currency
		);

		const creates: ProposedOperation[] = [];
		const bodies: StatementRowBody[] = [];
		for (const row of rows) {
			if (known.has(row.key)) {
				result.known++;
				continue;
			}
			known.add(row.key);
			added.add(row.key);

			if (isCardPayment(row)) {
				bodies.push({
					key: row.key,
					outcome: 'transfer',
					date: row.date,
					amount: row.amount
				});
				result.ignored++;
				continue;
			}

			if (row.direction === 'debit') {
				const matches = voiceExpenses.filter(
					(record) =>
						!linked.has(record.id) &&
						cents(record.fields.amount!) === cents(row.amount) &&
						Math.abs(expenseDay(record) - Date.parse(row.date)) <= MERGE_DAYS * DAY
				);
				if (matches.length === 1 && !contested.has(matches[0].id)) {
					linked.add(matches[0].id);
					bodies.push({
						key: row.key,
						outcome: 'merged',
						recordId: matches[0].id
					});
					result.merged++;
					continue;
				}
				if (matches.length > 0) {
					for (const match of matches) contested.add(match.id);
					bodies.push({
						key: row.key,
						row,
						candidates: matches.map((match) => match.id)
					});
					result.review++;
					continue;
				}
			}

			const rule = findRule(settings.budget, row);
			if (rule?.action === 'ignore') {
				bodies.push({ key: row.key, outcome: 'ignored' });
				result.ignored++;
			} else if (rule && (rule.action === 'income') === (row.direction === 'credit')) {
				const create = createFor(row, rule.category);
				creates.push(create);
				bodies.push({
					key: row.key,
					outcome: 'record',
					recordId: (create as { recordId: string }).recordId
				});
				result.added++;
			} else {
				bodies.push({ key: row.key, row });
				result.review++;
			}
		}

		await applyOperations(tx, account, null, creates, today);
		for (const body of bodies) await insertRow(tx, account, body);
	});

	if (balance) {
		const latest = await loadSettings(account);
		const stored = latest.budget.balances[kind];
		// On the same day, only a statement with new rows that day is the later one;
		// an earlier download imported again is not.
		const later =
			!stored ||
			stored.date < balance.date ||
			(stored.date === balance.date &&
				rows.some((row) => row.date === balance.date && added.has(row.key)));
		if (later) {
			await saveSettings(account, {
				...latest,
				budget: {
					...latest.budget,
					balances: { ...latest.budget.balances, [kind]: balance }
				}
			});
		}
	}
	return result;
}

/**
 * The user's money now: the latest savings balance less the latest card bill,
 * less expenses and plus income recorded after them. A record from a card
 * statement counts after the card's statement date, since the bill includes the
 * ones before it; any other record counts after the savings statement's latest
 * day. A card bill paid between the two dates is already out of the savings
 * balance, so it is added back. Null until a savings statement is imported.
 */
export async function currentBalance(
	account: Account,
	money: StoredRecord[],
	budget: Budget
): Promise<BalanceView | null> {
	const { savings, card } = budget.balances;
	if (!savings) return null;
	const done = await db.transaction((tx) => loadRows(tx, account, 'done'));
	const fromCard = new Set(
		done.flatMap(({ body }) =>
			body.recordId && body.key.startsWith('card:') ? [body.recordId] : []
		)
	);
	const view: BalanceView = {
		savings,
		card,
		spent: 0,
		received: 0,
		cardPaid: 0,
		total: 0,
		uncounted: 0
	};
	for (const record of money) {
		const day = record.fields.date ?? record.createdAt.toISOString().slice(0, 10);
		const after = card && fromCard.has(record.id) ? card.date : savings.date;
		if (day <= after || record.fields.amount === null) continue;
		if ((record.fields.currency ?? budget.currency) !== budget.currency) {
			view.uncounted++;
		} else if (record.type === 'expense') {
			view.spent += cents(record.fields.amount);
		} else if (record.type === 'income') {
			view.received += cents(record.fields.amount);
		}
	}
	if (card) {
		for (const { body } of done) {
			if (
				body.outcome === 'transfer' &&
				body.key.startsWith('savings:') &&
				body.date &&
				body.amount &&
				body.date > card.date &&
				body.date <= savings.date
			) {
				view.cardPaid += cents(body.amount);
			}
		}
	}
	view.total =
		(cents(savings.amount) -
			cents(card?.amount ?? 0) -
			view.spent +
			view.received +
			view.cardPaid) /
		100;
	view.spent /= 100;
	view.received /= 100;
	view.cardPaid /= 100;
	return view;
}

/** The rows waiting in review, oldest first, with the expenses each may be. */
export async function listReview(account: Account, money: StoredRecord[]): Promise<ReviewRow[]> {
	const rows = await db.transaction((tx) => loadRows(tx, account, 'review'));
	const byId = new Map(money.map((record) => [record.id, record]));
	return rows
		.filter((row) => row.body.row)
		.map(({ id, body }): ReviewRow => {
			const row = body.row!;
			return {
				id,
				account: row.account,
				date: row.date,
				direction: row.direction,
				amount: row.amount,
				payee: row.payee,
				vpa: row.vpa,
				text: row.text,
				candidates: (body.candidates ?? []).flatMap((candidateId) => {
					const record = byId.get(candidateId);
					if (!record || record.type !== 'expense') return [];
					return [
						{
							id: record.id,
							title: record.fields.title,
							amount: record.fields.amount ?? 0,
							date: record.fields.date ?? record.createdAt.toISOString().slice(0, 10)
						}
					];
				})
			};
		})
		.sort((a, b) => a.date.localeCompare(b.date));
}

/** What the user decided rows in review are. */
export type ReviewChoice =
	| { action: 'category'; category: string }
	| { action: 'income' }
	| { action: 'ignore' }
	| { action: 'merge'; recordId: string };

/**
 * Settles rows in review. A choice other than a merge also becomes the rule for
 * their payee, replacing any earlier one, when they all share a payee. Returns a
 * message for the user when the choice doesn't fit the rows, or null.
 */
export async function resolveReview(
	account: Account,
	ids: string[],
	choice: ReviewChoice,
	today: string
): Promise<string | null> {
	const settings = await loadSettings(account);
	const { budget } = settings;
	if (choice.action === 'category' && !budget.categories.some((c) => c.id === choice.category)) {
		return 'That category no longer exists. Reload and try again.';
	}

	let learned: StatementRule | null = null;
	const problem = await db.transaction(async (tx) => {
		await lockAccount(tx, account);
		const pending = (await loadRows(tx, account, 'review')).filter((row) => ids.includes(row.id));
		if (pending.length === 0 || pending.length !== new Set(ids).size) {
			return 'Those rows were already reviewed. Reload and try again.';
		}
		const rows = pending.map((row) => row.body.row!);
		const debits = rows.every((row) => row.direction === 'debit');
		const credits = rows.every((row) => row.direction === 'credit');
		if ((choice.action === 'category' || choice.action === 'merge') && !debits) {
			return 'Only money going out can be an expense.';
		}
		if (choice.action === 'income' && !credits) return 'Only money coming in can be income.';

		const bodies = new Map<string, StatementRowBody>();
		if (choice.action === 'merge') {
			const [row] = pending;
			if (pending.length !== 1 || !row.body.candidates?.includes(choice.recordId)) {
				return 'That expense is not one this row may be.';
			}
			const done = await loadRows(tx, account, 'done');
			const [expense] = await tx
				.select({ id: records.id })
				.from(records)
				.where(
					and(
						eq(records.id, choice.recordId),
						eq(records.userId, account.id),
						eq(records.type, 'expense')
					)
				);
			if (!expense || done.some((other) => other.body.recordId === choice.recordId)) {
				return 'That expense was deleted or already matched. Reload and try again.';
			}
			bodies.set(row.id, {
				key: row.body.key,
				outcome: 'merged',
				recordId: choice.recordId
			});
		} else if (choice.action === 'ignore') {
			for (const row of pending) bodies.set(row.id, { key: row.body.key, outcome: 'ignored' });
		} else {
			const category = choice.action === 'category' ? choice.category : null;
			const creates = pending.map((row) => createFor(row.body.row!, category));
			await applyOperations(tx, account, null, creates, today);
			pending.forEach((row, i) => {
				const recordId = (creates[i] as { recordId: string }).recordId;
				bodies.set(row.id, { key: row.body.key, outcome: 'record', recordId });
			});
		}
		for (const [id, body] of bodies) {
			await tx
				.update(statementRows)
				.set({
					status: 'done',
					body: encryptJson(account.key, body, bodyContext(id))
				})
				.where(and(eq(statementRows.id, id), eq(statementRows.userId, account.id)));
		}

		const [first] = rows;
		const samePayee = rows.every(
			(row) =>
				row.payee.toLowerCase() === first.payee.toLowerCase() &&
				(row.vpa ?? '').toLowerCase() === (first.vpa ?? '').toLowerCase()
		);
		if (choice.action !== 'merge' && first.payee && samePayee) {
			learned = {
				id: newCategoryId(),
				payee: first.payee,
				vpa: first.vpa,
				direction: first.direction,
				action: choice.action,
				category: choice.action === 'category' ? choice.category : null
			};
		}
		return null;
	});

	if (!problem && learned) {
		const rule: StatementRule = learned;
		const latest = await loadSettings(account);
		const others = latest.budget.rules.filter(
			(other) =>
				!(
					other.direction === rule.direction &&
					other.payee.toLowerCase() === rule.payee.toLowerCase() &&
					(other.vpa ?? '').toLowerCase() === (rule.vpa ?? '').toLowerCase()
				)
		);
		await saveSettings(account, {
			...latest,
			budget: { ...latest.budget, rules: [...others, rule] }
		});
	}
	return problem;
}

/** Removes a statement rule. Rows it filed stay as they are. */
export async function deleteRule(account: Account, id: string): Promise<void> {
	const settings = await loadSettings(account);
	const rules = settings.budget.rules.filter((rule) => rule.id !== id);
	await saveSettings(account, {
		...settings,
		budget: { ...settings.budget, rules }
	});
}
