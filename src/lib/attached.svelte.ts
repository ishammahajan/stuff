// What a utility screen tells the pill: the records the user dragged onto it, and
// which screen is open. Both go with the next recording, so the model knows what
// "this" means and which utility the memo most likely belongs to.
import type { ItemType } from './items.ts';

export interface AttachedItem {
	id: string;
	title: string;
}

class Attached {
	/** Records dragged onto the pill. They stay until a recording with them is sent. */
	items = $state<AttachedItem[]>([]);
	/** The utility screen that is open, by its record type. */
	screen = $state<ItemType | null>(null);
	/** Whether a drag is over the pill right now, so the pill can light up. */
	hovering = $state(false);

	/** The pill element. Set by the pill. */
	pill: HTMLElement | null = null;
	/** Starts a tap-style recording, unless one is already going. Set by the pill. */
	record: (() => void) | null = null;

	/** Whether a point on the screen is over the pill, with some slack for fingers. */
	isOverPill(x: number, y: number): boolean {
		const rect = this.pill?.getBoundingClientRect();
		if (!rect) return false;
		const slack = 24;
		return (
			x >= rect.left - slack &&
			x <= rect.right + slack &&
			y >= rect.top - slack &&
			y <= rect.bottom + slack
		);
	}

	/** Attaches records to the pill and starts recording about them. */
	drop(items: AttachedItem[]): void {
		this.hovering = false;
		if (items.length === 0) return;
		this.items = items;
		this.record?.();
	}
}

export const attached = new Attached();
