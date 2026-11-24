// The things a voice capture can turn into. Shared by the server and the pages.

export const ITEM_TYPES = ['task', 'note', 'expense', 'income'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const REPEAT_UNITS = ['day', 'week', 'month', 'year'] as const;
export type RepeatUnit = (typeof REPEAT_UNITS)[number];

/** How often a task comes back, for example every 2 weeks. */
export interface Repeat {
	every: number;
	unit: RepeatUnit;
}

/** The content of a record. It is stored encrypted, apart from its type. */
export interface ItemFields {
	/** Short summary: the task, the note's subject, or what the money was for. */
	title: string;
	/** Anything else that was said about it. */
	details: string | null;
	/** Money amount; set for expense and income only. */
	amount: number | null;
	/** ISO 4217 code, only when a currency was spoken. */
	currency: string | null;
	/** ISO date (YYYY-MM-DD): a task's due date or a transaction's date. */
	date: string | null;
	tags: string[];
	/** A task marked as important. */
	important: boolean;
	/** A repeating task: completing it moves its date to the next occurrence. */
	repeat: Repeat | null;
	/**
	 * When to remind about a task, as local wall time (YYYY-MM-DDTHH:MM). Without
	 * it, a dated task is reminded at a fixed hour on its date.
	 */
	remindAt: string | null;
}

/** Fills in fields that records saved before they existed lack. */
export function withDefaults(fields: Partial<ItemFields> & { title: string }): ItemFields {
	return {
		details: null,
		amount: null,
		currency: null,
		date: null,
		tags: [],
		important: false,
		repeat: null,
		remindAt: null,
		...fields
	};
}

/** Adds days to an ISO date (YYYY-MM-DD), or to the date part of YYYY-MM-DDTHH:MM. */
export function addDays(value: string, days: number): string {
	const [y, m, d] = value.slice(0, 10).split('-').map(Number);
	const date = new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
	return date + value.slice(10);
}

/** Whole days from one ISO date to another. */
export function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(to) - Date.parse(from)) / (24 * 60 * 60 * 1000));
}

export interface Item extends ItemFields {
	type: ItemType;
	/** Whether a task is done. */
	completed: boolean;
}

/** A task as the Tasks screen shows it. */
export interface TaskView extends ItemFields {
	id: string;
	/** ISO timestamp of when it was completed, or null while open. */
	completedAt: string | null;
}

/** Describes a repeat rule, for example "every 2 weeks". */
export function describeRepeat(repeat: Repeat): string {
	return repeat.every === 1 ? `every ${repeat.unit}` : `every ${repeat.every} ${repeat.unit}s`;
}

/** Today's date in the browser's time zone, as YYYY-MM-DD. */
export function localDate(now = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The next date of a repeating task after `today`: steps from its due date (or from
 * today when it has none) until the result is later than today.
 */
export function nextOccurrence(date: string | null, repeat: Repeat, today: string): string {
	const [y, m, d] = (date ?? today).split('-').map(Number);
	const every = Math.max(1, repeat.every);
	// Counts steps from the original date, so a month-end date stays at month end
	// where it can instead of drifting earlier.
	for (let step = 1; ; step++) {
		let next: Date;
		if (repeat.unit === 'day' || repeat.unit === 'week') {
			const days = every * step * (repeat.unit === 'week' ? 7 : 1);
			next = new Date(Date.UTC(y, m - 1, d + days));
		} else {
			const months = every * step * (repeat.unit === 'year' ? 12 : 1);
			const lastDay = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
			next = new Date(Date.UTC(y, m - 1 + months, Math.min(d, lastDay)));
		}
		const iso = next.toISOString().slice(0, 10);
		if (iso > today) return iso;
	}
}

export const OPERATION_KINDS = ['create', 'update', 'complete', 'reopen', 'delete'] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/** One change a capture made, as the inbox shows it. */
export interface OperationView {
	id: string;
	kind: OperationKind;
	/** The record after the change, or before it for a delete. */
	item: Item;
	/** The record before an update, to show what changed. */
	previous: Item | null;
	undone: boolean;
}

/** `asking` means the capture is waiting for the user to answer its question. */
export type CaptureStatus = 'pending' | 'asking' | 'done' | 'failed';

/** A question the model asked instead of guessing. */
export interface QuestionView {
	text: string;
	/** Labels of the answers offered, in order. */
	options: string[];
	/** What settled it: an option's label, or a note such as "Dismissed". Null while open. */
	answer: string | null;
}

export interface CaptureView {
	id: string;
	createdAt: Date;
	status: CaptureStatus;
	transcript: string | null;
	/** The name of the attached file, if any. */
	fileName: string | null;
	/** The answer to a question the user asked, if they asked one. */
	answer: string | null;
	operations: OperationView[];
	question: QuestionView | null;
	error: string | null;
}
