<script lang="ts">
	import { formatSet, type Measure, type SetValues, type WorkoutSet } from '#lib/items.ts';

	interface Props {
		/** The set's number as shown, from 1. */
		number: number;
		/** The set, or null for a new extra set. */
		set: WorkoutSet | null;
		measure: Measure;
		/** Saves what was done, or clears it with null. */
		onlog: (done: SetValues | null) => Promise<void>;
	}

	let { number, set, measure, onlog }: Props = $props();

	// The inputs start at what was done, or else at the target, so logging a set as
	// planned is a single tap.
	const start = () => set?.done ?? set?.target ?? null;
	let weight = $state<number | null>(start()?.weight ?? null);
	let reps = $state<number | null>(start()?.reps ?? null);
	let seconds = $state<number | null>(start()?.seconds ?? null);
	let busy = $state(false);

	let done = $derived(set?.done ?? null);

	const empty = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

	async function toggle() {
		busy = true;
		try {
			if (done) await onlog(null);
			else await onlog({ weight: empty(weight), reps: empty(reps), seconds: empty(seconds) });
		} finally {
			busy = false;
		}
	}
</script>

<div class="row" class:done>
	<span class="number">{number}</span>
	<div class="inputs">
		{#if measure === 'weight_reps'}
			<label>
				<input type="number" inputmode="decimal" step="0.5" min="0" bind:value={weight} disabled={!!done} aria-label={`Set ${number} weight in kg`} />
				<span>kg</span>
			</label>
			<span class="times">×</span>
		{/if}
		{#if measure !== 'time'}
			<label>
				<input type="number" inputmode="numeric" min="0" bind:value={reps} disabled={!!done} aria-label={`Set ${number} reps`} />
				<span>reps</span>
			</label>
		{:else}
			<label>
				<input type="number" inputmode="numeric" min="0" bind:value={seconds} disabled={!!done} aria-label={`Set ${number} seconds`} />
				<span>s</span>
			</label>
		{/if}
	</div>
	{#if set?.target && !done}
		<span class="target">{formatSet(set.target, measure)}</span>
	{/if}
	<button
		class="check"
		aria-pressed={!!done}
		aria-label={done ? `Clear set ${number}` : `Log set ${number}`}
		disabled={busy}
		onclick={toggle}
	>
		<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
	</button>
</div>

<style>
	.row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0;
	}

	.number {
		flex: none;
		width: 1.25rem;
		color: var(--muted);
		font-size: 0.875rem;
		text-align: center;
	}

	.inputs {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
	}

	label {
		display: flex;
		align-items: center;
		gap: 0.2rem;
		font-size: 0.8125rem;
		color: var(--muted);
	}

	input {
		width: 3.75rem;
		padding: 0.35rem 0.4rem;
		border-radius: 0.5rem;
		border: 1px solid var(--border);
		background: var(--bg);
		color: var(--text);
		font: inherit;
		font-size: 1rem;
	}

	input:disabled {
		border-color: transparent;
		background: transparent;
		color: var(--text);
		opacity: 1;
	}

	.times {
		color: var(--muted);
	}

	.target {
		font-size: 0.75rem;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}

	.check {
		flex: none;
		margin-left: auto;
		width: 2.25rem;
		height: 2.25rem;
		display: grid;
		place-items: center;
		border-radius: 50%;
		border: 1.5px solid var(--border);
		background: transparent;
		color: var(--muted);
	}

	.check svg {
		width: 1.125rem;
		height: 1.125rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 2.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.done .check {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--on-accent);
	}
</style>
