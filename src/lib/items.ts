// The things a voice capture can turn into. Shared by the server and the pages.

export const ITEM_TYPES = ['task', 'note', 'expense', 'income'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

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
}

export interface Item extends ItemFields {
	type: ItemType;
	/** Whether a task is done. */
	completed: boolean;
}

export const OPERATION_KINDS = ['create', 'update', 'complete', 'delete'] as const;
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

export type CaptureStatus = 'pending' | 'done' | 'failed';

export interface CaptureView {
	id: string;
	createdAt: Date;
	status: CaptureStatus;
	transcript: string | null;
	operations: OperationView[];
	error: string | null;
}
