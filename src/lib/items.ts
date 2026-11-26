// The things a voice capture can turn into. Shared by the server and the pages.

export const ITEM_TYPES = [
	'task',
	'note',
	'expense',
	'income',
	'workout',
	'trainer_note',
	'goal',
	'exercise_guide'
] as const;
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
	/** The named list a note belongs to, such as "Movies to watch". */
	list: string | null;
	/** An expense's budget category, by its ID in the budget settings. */
	category: string | null;
	/**
	 * Other people's shares of an expense the speaker paid. `amount` stays the whole
	 * bill; only what is left after the shares counts toward the budget.
	 */
	shares: Share[];
	/** A workout's exercises, in order, with planned and done sets. */
	exercises: Exercise[];
	/**
	 * A workout's warm-up and stretching, one step per line, written for the
	 * speaker's condition on that day.
	 */
	warmup: string | null;
	/** A goal's exercise and the set that reaches it. */
	goal: Goal | null;
}

/** How an exercise moves, so the trainer can swap like for like and judge balance. */
export const MOVEMENT_PATTERNS = [
	'horizontal_push',
	'vertical_push',
	'horizontal_pull',
	'vertical_pull',
	'squat',
	'hinge',
	'lunge',
	'carry',
	'core',
	'isolation',
	'conditioning'
] as const;
export type MovementPattern = (typeof MOVEMENT_PATTERNS)[number];

export const MUSCLES = [
	'chest',
	'back',
	'shoulders',
	'biceps',
	'triceps',
	'forearms',
	'core',
	'quads',
	'hamstrings',
	'glutes',
	'calves'
] as const;
export type Muscle = (typeof MUSCLES)[number];

/** What a set of an exercise counts: weight and reps, reps alone, or seconds held. */
export const MEASURES = ['weight_reps', 'reps', 'time'] as const;
export type Measure = (typeof MEASURES)[number];

/** One set's numbers. Weights are in kilograms; unused values are null. */
export interface SetValues {
	weight: number | null;
	reps: number | null;
	seconds: number | null;
}

/** A set: what was planned, if anything, and what was done, once logged. */
export interface WorkoutSet {
	target: SetValues | null;
	done: SetValues | null;
}

export interface Exercise {
	/** Reused exactly across workouts, so its history adds up. */
	name: string;
	pattern: MovementPattern;
	muscles: Muscle[];
	measure: Measure;
	sets: WorkoutSet[];
	/** The trainer's cue for it, such as "2 reps in reserve". */
	note: string | null;
}

/**
 * A measurable training goal: one set of an exercise that reaches the target, such
 * as 150 kg × 1 on the bench, 20 pull-ups, or a 120 s plank. `date` on the record
 * is the deadline, if any, and completing the record marks it reached.
 */
export interface Goal {
	/** The exercise's name, as the workouts use it. */
	exercise: string;
	target: SetValues;
}

/** The measure a set's values imply: weight, else seconds, else reps. */
export function measureOf(values: SetValues): Measure {
	if (values.weight !== null) return 'weight_reps';
	if (values.seconds !== null) return 'time';
	return 'reps';
}

/** Formats a set's numbers for its measure, for example "60 kg × 8", "15 reps", or "45 s". */
export function formatSet(values: SetValues, measure: Measure): string {
	if (measure === 'time') return `${values.seconds ?? '?'} s`;
	if (measure === 'reps') {
		const reps = `${values.reps ?? '?'} reps`;
		return values.weight ? `${reps} + ${values.weight} kg` : reps;
	}
	return `${values.weight ?? '?'} kg × ${values.reps ?? '?'}`;
}

/** Whether any set of a workout was logged. */
export function anyDone(exercises: Exercise[]): boolean {
	return exercises.some((exercise) => exercise.sets.some((set) => set.done));
}

/** One person's part of a shared expense, and whether they have paid it back. */
export interface Share {
	person: string;
	amount: number;
	settled: boolean;
}

/** The speaker's own part of an expense: the amount less everyone else's shares. */
export function ownShare(fields: Pick<ItemFields, 'amount' | 'shares'>): number {
	const others = fields.shares.reduce((sum, share) => sum + share.amount, 0);
	return Math.max(0, Math.round(((fields.amount ?? 0) - others) * 100) / 100);
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
		list: null,
		category: null,
		shares: [],
		exercises: [],
		warmup: null,
		goal: null,
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

/** A note as the Knowledge screen shows it. */
export interface NoteView extends ItemFields {
	id: string;
	createdAt: string;
	/** How many passages of a PDF's text the note holds, or 0 for a plain note. */
	passages: number;
}

/** A workout as the Gym screen shows it. */
export interface WorkoutView extends ItemFields {
	id: string;
	createdAt: string;
	/** ISO timestamp of when it was finished, or null. */
	completedAt: string | null;
}

/** A goal as the Gym screen shows it, with its progress worked out on the server. */
export interface GoalView {
	id: string;
	title: string;
	details: string | null;
	goal: Goal;
	/** The deadline, if any. */
	date: string | null;
	createdAt: string;
	/** When it was reached, or null. */
	completedAt: string | null;
	/** The best score before the goal was set, the best now, and the target's. */
	start: number | null;
	current: number | null;
	target: number;
	/** What the scores count: estimated max in kg, reps, or seconds. */
	unit: string;
	/** Weeks to reach it at the recent pace, or null without a rising trend. */
	weeksLeft: number | null;
}

/**
 * How to do one exercise, written once by the trainer. Its record's title is the
 * exercise's name and its details are the steps.
 */
export interface ExerciseGuideView {
	id: string;
	name: string;
	guide: string;
}

/** Something the trainer remembers, as the Gym screen shows it. */
export interface TrainerNoteView {
	id: string;
	title: string;
	details: string | null;
	createdAt: string;
}

/** A money record as the Budget screen shows it. */
export interface MoneyView extends ItemFields {
	id: string;
	type: 'expense' | 'income';
	createdAt: string;
}

/** A budget category and how much it gets each month. */
export interface Category {
	/** A short random ID, which expenses refer to, so a rename keeps them. */
	id: string;
	name: string;
	monthly: number;
}

/** The user's budget. Each month starts fresh: unspent money doesn't carry over. */
export interface Budget {
	categories: Category[];
	/** A fixed income expected each month, or null. */
	monthlyIncome: number | null;
	/** ISO 4217 code that amounts without a currency are in. */
	currency: string;
	/** What to do with statement rows of a known payee, learned in review. */
	rules: StatementRule[];
	/** From the latest statement of each account imported so far. */
	balances: {
		/** The savings balance after the statement's latest row. */
		savings: StatementBalance | null;
		/** The card's total amount due on its statement date. */
		card: StatementBalance | null;
	};
}

/** An amount a statement gives as of a day. */
export interface StatementBalance {
	amount: number;
	/** ISO date, YYYY-MM-DD. */
	date: string;
}

/**
 * The money the user has: the latest savings balance less the latest card bill,
 * updated by what was recorded after each statement.
 */
export interface BalanceView {
	savings: StatementBalance;
	card: StatementBalance | null;
	/** Expenses after the statements: card ones after the card's, others after the savings'. */
	spent: number;
	/** Income after the statements, counted the same way. */
	received: number;
	/** Card bill payments in the savings statement after the card statement date. */
	cardPaid: number;
	total: number;
	/** Records after the statements in another currency, which aren't counted. */
	uncounted: number;
}

/**
 * Files a payee's statement rows without review: money out under a category or as
 * not spending, money in as income or not.
 */
export interface StatementRule {
	id: string;
	/** As the statement shortens it; matched without regard to case. */
	payee: string;
	/** The UPI address's visible part, or null when the bank gives none. */
	vpa: string | null;
	direction: 'debit' | 'credit';
	action: 'category' | 'income' | 'ignore';
	/** The category's ID, for `category` only. */
	category: string | null;
}

/** An expense recorded by voice that a statement row may be. */
export interface ReviewCandidate {
	id: string;
	title: string;
	amount: number;
	date: string;
}

/** A statement row waiting for the user to say what it is. */
export interface ReviewRow {
	id: string;
	account: 'savings' | 'card';
	date: string;
	direction: 'debit' | 'credit';
	amount: number;
	payee: string;
	vpa: string | null;
	/** The bank's description of the row. */
	text: string;
	/** Expenses this may be; when there are some, the row is reviewed on its own. */
	candidates: ReviewCandidate[];
}

/** Formats an amount of money in the budget's currency, without decimals for whole numbers. */
export function formatMoney(amount: number, currency: string): string {
	return new Intl.NumberFormat('en-IN', {
		style: 'currency',
		currency,
		maximumFractionDigits: Number.isInteger(amount) ? 0 : 2
	}).format(amount);
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
