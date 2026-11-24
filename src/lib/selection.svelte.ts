// Selecting records on a utility screen and dragging them onto the pill. Tapping a
// row selects it; a press on a selected row that moves becomes a drag of the whole
// selection, and dropping it on the pill attaches the records and starts recording.
import { SvelteSet } from 'svelte/reactivity';
import { attached, type AttachedItem } from './attached.svelte.ts';

// A press on a selected row that moves this far is a drag, not a tap.
const DRAG_PX = 8;

export class Selection {
	readonly selected = new SvelteSet<string>();
	/** Where the dragged selection is, while dragging. */
	drag = $state<{ x: number; y: number } | null>(null);

	#items: () => AttachedItem[];
	#press: { x: number; y: number } | null = null;
	#dragged = false;

	/** `items` returns the screen's records, so a selection can be attached by title. */
	constructor(items: () => AttachedItem[]) {
		this.#items = items;
	}

	/** Attaches the selected records to the pill and starts recording about them. */
	talkAbout(): void {
		attached.drop(this.#items().filter((item) => this.selected.has(item.id)));
		this.selected.clear();
	}

	/** Selects or unselects a row, unless the click ends a drag. */
	toggle(id: string): void {
		if (this.#dragged) {
			this.#dragged = false;
			return;
		}
		if (this.selected.has(id)) this.selected.delete(id);
		else this.selected.add(id);
	}

	/** Drops selected records that no longer exist. */
	prune(ids: Iterable<string>): void {
		const existing = new Set(ids);
		for (const id of this.selected) if (!existing.has(id)) this.selected.delete(id);
	}

	/**
	 * Pointer handlers for a row. Presses on elements matching `ignore`, such as the
	 * row's own buttons, don't start a drag.
	 */
	handlers(id: string, ignore: string) {
		return {
			onpointerdown: (event: PointerEvent) => {
				this.#dragged = false;
				if (!event.isPrimary || !this.selected.has(id)) return;
				if ((event.target as HTMLElement).closest(ignore)) return;
				this.#press = { x: event.clientX, y: event.clientY };
				try {
					(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
				} catch {
					// The pointer is already gone.
				}
			},
			onpointermove: (event: PointerEvent) => {
				const press = this.#press;
				if (!press) return;
				if (!this.drag && Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_PX) {
					return;
				}
				this.drag = { x: event.clientX, y: event.clientY };
				attached.hovering = attached.isOverPill(event.clientX, event.clientY);
			},
			onpointerup: (event: PointerEvent) => {
				if (!this.#press) return;
				this.#press = null;
				if (!this.drag) return;
				this.#dragged = true;
				this.drag = null;
				if (attached.isOverPill(event.clientX, event.clientY)) this.talkAbout();
				attached.hovering = false;
			},
			onpointercancel: () => {
				this.#press = null;
				this.drag = null;
				attached.hovering = false;
			}
		};
	}
}
