// The things a voice capture can turn into. Shared by the server and the pages.

export const ITEM_TYPES = ['task', 'note', 'expense', 'income'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export interface Item {
	type: ItemType;
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
}

export type CaptureStatus = 'pending' | 'done' | 'failed';

export interface CaptureView {
	id: string;
	createdAt: Date;
	status: CaptureStatus;
	transcript: string | null;
	items: Item[];
	error: string | null;
}
