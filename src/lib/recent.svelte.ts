// The latest captures, shared by the pill (which reports new ones), the recent
// panel above it (which shows them), and utility screens (which reload when one
// finishes). Loaded from the client, because the cached dashboard HTML can be stale.
import { localDate, type CaptureView } from './items.ts';

const POLL_MS = 2000;

class Recent {
	captures = $state<CaptureView[]>([]);
	/** Why the last undo or answer failed, if it did. */
	message = $state('');
	/** The open question the pill's next recording answers, if the user chose to reply. */
	replyTo = $state<{ id: string; question: string } | null>(null);
	/** Whether the recent panel above the pill is open. */
	open = $state(false);

	/** Whether a capture is processing or waiting for an answer, for the panel button's dot. */
	get busy(): boolean {
		return this.captures.some((c) => c.status === 'pending' || c.status === 'asking');
	}

	#timer: ReturnType<typeof setTimeout> | undefined;

	/** Loads the latest captures, and polls again while any is still processing. */
	async refresh(): Promise<void> {
		clearTimeout(this.#timer);
		const response = await fetch('/api/captures').catch(() => null);
		if (response?.ok) {
			const captures: CaptureView[] = await response.json();
			this.captures = captures.map((capture) => ({
				...capture,
				createdAt: new Date(capture.createdAt)
			}));
		}
		// Offline or a server error: try again on the next poll. A signed-out 401 doesn't.
		const retry = !response || response.status >= 500;
		if (retry || (response.ok && this.captures.some((c) => c.status === 'pending'))) {
			this.#timer = setTimeout(() => this.refresh(), POLL_MS);
		}
	}

	async undo(operationId: string): Promise<void> {
		await this.#post(`/api/operations/${operationId}/undo`, undefined, 'Undo');
	}

	/** Picks an answer to a capture's question, or dismisses it when `option` is null. */
	async answer(captureId: string, option: number | null): Promise<void> {
		if (this.replyTo?.id === captureId) this.replyTo = null;
		await this.#post(`/api/captures/${captureId}/answer`, { option, localDate: localDate() }, 'Answer');
	}

	async #post(url: string, body: unknown, action: string): Promise<void> {
		this.message = '';
		const response = await fetch(url, {
			method: 'POST',
			headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		}).catch(() => null);
		if (!response) {
			this.message = 'Could not reach the server. Try again.';
		} else if (!response.ok) {
			const reply = await response.json().catch(() => null);
			this.message = reply?.message ?? `${action} failed (${response.status}).`;
		}
		await this.refresh();
	}
}

export const recent = new Recent();
