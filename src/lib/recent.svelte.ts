// The latest captures, shared by the pill (which reports new ones) and the home
// screen's recent strip (which shows them). Loaded from the client, because the
// cached dashboard HTML can be stale.
import type { CaptureView } from './items.ts';

const POLL_MS = 2000;

class Recent {
	captures = $state<CaptureView[]>([]);
	/** Why the last undo failed, if it did. */
	message = $state('');

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
		this.message = '';
		const response = await fetch(`/api/operations/${operationId}/undo`, { method: 'POST' }).catch(
			() => null
		);
		if (!response) {
			this.message = 'Could not reach the server. Try again.';
		} else if (!response.ok) {
			const body = await response.json().catch(() => null);
			this.message = body?.message ?? `Undo failed (${response.status}).`;
		}
		await this.refresh();
	}
}

export const recent = new Recent();
