// Turns an ICICI Bank statement grid into transactions. Two layouts are known: the
// savings account's transaction history and the credit card statement. Which one a
// file is comes from its header row. It has no SvelteKit imports, so scripts can
// use it.
import { createHash } from 'node:crypto';
import type { StatementBalance } from '../items.ts';
import type { Cell, Grid } from './spreadsheet.ts';

export type StatementAccount = 'savings' | 'card';
export type Direction = 'debit' | 'credit';

/** One transaction from a statement. */
export interface StatementRow {
	/** Stable across downloads of overlapping periods, so a row is imported once. */
	key: string;
	account: StatementAccount;
	/** ISO date, YYYY-MM-DD. */
	date: string;
	direction: Direction;
	/** Always positive; `direction` gives the sign. A card purchase includes its fees. */
	amount: number;
	/** Who was paid or paid in, as the bank shortened it. Empty when unknown. */
	payee: string;
	/** A UPI address's visible part, or null. */
	vpa: string | null;
	/** The bank's full description of the row. */
	text: string;
}

export interface Statement {
	account: StatementAccount;
	rows: StatementRow[];
	/**
	 * Savings: the balance after the latest row. Card: the total amount due on the
	 * statement date. Null when the statement doesn't give it.
	 */
	balance: StatementBalance | null;
}

export class StatementError extends Error {}

const normalise = (cell: Cell) =>
	String(cell)
		.toLowerCase()
		.replace(/\(inr\)/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();

/** The index of the first row whose cells include every label, and each label's column. */
function findHeader(grid: Grid, labels: string[]) {
	for (let row = 0; row < Math.min(grid.length, 100); row++) {
		const cells = grid[row].map(normalise);
		const columns = labels.map((label) => cells.indexOf(label));
		if (columns.every((column) => column >= 0)) return { row, columns };
	}
	return null;
}

/** Recognises the statement and parses its rows. */
export function parseStatement(grid: Grid): Statement {
	const savings = findHeader(grid, [
		'transaction date',
		'transaction remarks',
		'withdrawal amount',
		'deposit amount',
		'balance'
	]);
	if (savings) return parseSavings(grid, savings.row, savings.columns);
	const card = findHeader(grid, ['transaction date', 'details', 'amount', 'reference number']);
	if (card) return parseCard(grid, card.row, card.columns);
	throw new StatementError(
		'This is not an ICICI savings or credit card statement. Download the transaction history as Excel.'
	);
}

/** A date written as DD/MM/YYYY or DD-MM-YYYY, or an Excel date number, as YYYY-MM-DD. */
export function parseDate(cell: Cell): string | null {
	if (typeof cell === 'number') {
		// Excel counts days from 1899-12-30.
		if (cell < 20000 || cell > 80000) return null;
		return new Date(Date.UTC(1899, 11, 30) + Math.floor(cell) * 86400000)
			.toISOString()
			.slice(0, 10);
	}
	const match = cell.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
	if (!match) return null;
	const [, d, m, y] = match.map(Number);
	const date = new Date(Date.UTC(y, m - 1, d));
	if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
	return date.toISOString().slice(0, 10);
}

/** An amount cell as a number of rupees, or null. */
function parseAmount(cell: Cell): number | null {
	if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null;
	const text = cell.replace(/[,\s]/g, '');
	if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
	return Number(text);
}

const cents = (value: number) => Math.round(value * 100);
const rupees = (value: number) => Math.round(value * 100) / 100;

// Rows after this are the bank's legend of abbreviations, not transactions.
const LEGEND = /legends used/i;

function parseSavings(grid: Grid, headerRow: number, columns: number[]): Statement {
	const [dateColumn, remarksColumn, withdrawalColumn, depositColumn, balanceColumn] = columns;
	const parsed: {
		date: string;
		text: string;
		withdrawal: number;
		deposit: number;
		balance: number;
	}[] = [];
	let skipped = 0;
	for (let i = headerRow + 1; i < grid.length; i++) {
		const cells = grid[i];
		const cell = (column: number): Cell => cells[column] ?? '';
		if (cells.some((value) => typeof value === 'string' && LEGEND.test(value))) break;
		const date = parseDate(cell(dateColumn));
		const remarks = String(cell(remarksColumn));
		if (!date) {
			// A long remark spills into a row of its own, which may split a word, so
			// it is joined without a space.
			const rest = cells.filter((value, column) => column !== remarksColumn && value !== '');
			if (remarks && rest.length === 0 && parsed.length > 0)
				parsed[parsed.length - 1].text += remarks;
			continue;
		}
		const withdrawal = parseAmount(cell(withdrawalColumn));
		const deposit = parseAmount(cell(depositColumn));
		const balance = parseAmount(cell(balanceColumn));
		if (
			withdrawal === null ||
			deposit === null ||
			balance === null ||
			withdrawal > 0 === deposit > 0
		) {
			skipped++;
			continue;
		}
		parsed.push({ date, text: remarks, withdrawal, deposit, balance });
	}
	if (skipped > 0) {
		throw new StatementError(
			`${skipped} rows of this statement couldn't be read, so nothing was imported.`
		);
	}

	// Every row carries the running balance, so the parse can be checked: in date
	// order, each balance is the one before less the withdrawal plus the deposit.
	const follows = (before: (typeof parsed)[number], row: (typeof parsed)[number]) =>
		cents(before.balance) - cents(row.withdrawal) + cents(row.deposit) === cents(row.balance);
	const ascending = parsed.every((row, i) => i === 0 || follows(parsed[i - 1], row));
	const descending = parsed.every(
		(row, i) => i === parsed.length - 1 || follows(parsed[i + 1], row)
	);
	if (!ascending && !descending) {
		throw new StatementError("This statement's balances don't add up, so nothing was imported.");
	}
	// The latest row is last in date order, so first when the statement runs newest first.
	const newestFirst = !ascending || (descending && parsed[0].date > parsed[parsed.length - 1].date);
	const latest = newestFirst ? parsed[0] : parsed[parsed.length - 1];
	const balance = latest ? { amount: rupees(latest.balance), date: latest.date } : null;

	const rows = parsed.map((row): StatementRow => {
		const direction: Direction = row.withdrawal > 0 ? 'debit' : 'credit';
		const amount = rupees(row.withdrawal || row.deposit);
		const { payee, vpa, reference } = describeRemarks(row.text);
		return {
			key: reference
				? `savings:${reference}:${direction}`
				: `savings:${row.date}:${direction}:${amount}:${rupees(row.balance)}`,
			account: 'savings',
			date: row.date,
			direction,
			amount,
			payee,
			vpa,
			text: row.text
		};
	});
	return { account: 'savings', rows, balance };
}

/**
 * Reads a savings remark. A UPI remark is
 * `UPI/<payee>/<vpa>/<note>/<bank>/<reference>/<transaction id>`, where the note may
 * itself hold slashes. Other remarks (NEFT, IMPS, BIL, and so on) give a payee when
 * they are slash-separated.
 */
export function describeRemarks(text: string): {
	payee: string;
	vpa: string | null;
	reference: string | null;
} {
	const parts = text.split('/').map((part) => part.trim());
	if (parts[0]?.toUpperCase() === 'UPI' && parts.length >= 6) {
		const reference = parts[parts.length - 2];
		return {
			payee: parts[1],
			vpa: parts[2] || null,
			reference: /^\d{6,}$/.test(reference) ? reference : null
		};
	}
	return {
		payee: parts.length > 1 ? parts[1] : '',
		vpa: null,
		reference: null
	};
}

// Rows a foreign purchase adds on the same day, which belong to that purchase.
const FEE = /^(markup fee|[sci]gst-ci)/i;

function parseCard(grid: Grid, headerRow: number, columns: number[]): Statement {
	const [dateColumn, detailsColumn, amountColumn, referenceColumn] = columns;
	type Parsed = {
		date: string;
		text: string;
		direction: Direction;
		cents: number;
		reference: string;
	};
	const parsed: Parsed[] = [];
	let skipped = 0;
	for (let i = headerRow + 1; i < grid.length; i++) {
		const cells = grid[i];
		const date = parseDate(cells[dateColumn] ?? '');
		if (!date) continue;
		const match = String(cells[amountColumn] ?? '').match(/^([\d,]+(?:\.\d+)?)\s*(Dr|Cr)\.?$/i);
		const value = match ? parseAmount(match[1]) : null;
		if (!match || value === null || value <= 0) {
			skipped++;
			continue;
		}
		const text = String(cells[detailsColumn] ?? '').replace(/\s+/g, ' ');
		const direction: Direction = match[2].toLowerCase() === 'dr' ? 'debit' : 'credit';
		const fee = FEE.test(text) ? findFeeParent(parsed, date) : null;
		const signed = direction === 'debit' ? cents(value) : -cents(value);
		if (fee) {
			// A fee adds to its purchase; a reversed fee takes away from it.
			fee.cents += fee.direction === 'debit' ? signed : -signed;
			continue;
		}
		parsed.push({
			date,
			text,
			direction,
			cents: cents(value),
			reference: String(cells[referenceColumn] ?? '')
		});
	}
	if (skipped > 0) {
		throw new StatementError(
			`${skipped} rows of this statement couldn't be read, so nothing was imported.`
		);
	}

	// A reference number is the key, unless it is missing or repeated; then the row's
	// own values are, counted so two identical rows stay apart.
	const seen = new Map<string, number>();
	for (const row of parsed) seen.set(row.reference, (seen.get(row.reference) ?? 0) + 1);
	const occurrences = new Map<string, number>();
	const rows = parsed
		.filter((row) => row.cents > 0)
		.map((row): StatementRow => {
			const amount = row.cents / 100;
			let key = `card:${row.reference}:${row.direction}`;
			if (!/^\w{6,}$/.test(row.reference) || seen.get(row.reference)! > 1) {
				const hash = createHash('sha256').update(row.text).digest('hex').slice(0, 10);
				const base = `card:${row.date}:${row.direction}:${amount}:${hash}`;
				const n = (occurrences.get(base) ?? 0) + 1;
				occurrences.set(base, n);
				key = `${base}:${n}`;
			}
			return {
				key,
				account: 'card',
				date: row.date,
				direction: row.direction,
				amount,
				payee: cardPayee(row.text),
				vpa: null,
				text: row.text
			};
		});
	return { account: 'card', rows, balance: cardDue(grid, headerRow) };
}

/**
 * The total amount due and the statement date, from the summary above the rows.
 * Each label's value is the next filled cell to its right.
 */
function cardDue(grid: Grid, headerRow: number): StatementBalance | null {
	const valueAfter = (label: RegExp): Cell | null => {
		for (const cells of grid.slice(0, headerRow)) {
			const column = cells.findIndex((cell) => typeof cell === 'string' && label.test(cell.trim()));
			if (column < 0) continue;
			return cells.slice(column + 1).find((cell) => cell !== '') ?? null;
		}
		return null;
	};
	const due = valueAfter(/^total amount due/i);
	const date = valueAfter(/^statement date/i);
	if (due === null || date === null) return null;
	const amount =
		typeof due === 'number' ? due : parseAmount(due.replace(/rs\.?|inr|[^\d.,-]/gi, ''));
	const day = parseDate(typeof date === 'string' ? date.trim() : date);
	if (amount === null || !day) return null;
	return { amount: rupees(amount), date: day };
}

/** The purchase a fee row belongs to: the latest earlier non-fee row of the same day. */
function findFeeParent<T extends { date: string; text: string }>(
	parsed: T[],
	date: string
): T | null {
	const last = parsed[parsed.length - 1];
	return last && last.date === date ? last : null;
}

/** A card row's merchant: its description without numbers, in capitals. */
function cardPayee(text: string): string {
	return text
		.toUpperCase()
		.split(' ')
		.filter((word) => word && !/^[\d*#-]+$/.test(word))
		.join(' ')
		.slice(0, 60);
}

/**
 * Card bill payments move money between the user's own accounts, so they are not
 * spending. These patterns are a first guess: no statement with a bill payment has
 * been seen yet. A payment they miss waits in review, where "Not spending" teaches
 * a rule for its payee.
 */
const SAVINGS_CARD_PAYMENT = /credit ?card|\bcc ?(payment|autopay|bill)|autopay|bbps/i;
const CARD_PAYMENT_RECEIVED = /payment received|thank you|bbps|autopay|infinity payment/i;

/** Whether a row is a credit card bill payment, on either statement. */
export function isCardPayment(row: StatementRow): boolean {
	if (row.account === 'savings') {
		return (
			row.direction === 'debit' && !/^UPI\//i.test(row.text) && SAVINGS_CARD_PAYMENT.test(row.text)
		);
	}
	return row.direction === 'credit' && CARD_PAYMENT_RECEIVED.test(row.text);
}
