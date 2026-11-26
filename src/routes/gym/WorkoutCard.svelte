<script lang="ts">
	import { attached } from '#lib/attached.svelte.ts';
	import type { SetValues, WorkoutView } from '#lib/items.ts';
	import SetRow from './SetRow.svelte';

	interface Props {
		workout: WorkoutView;
		/** How the day is labelled, for example "Today" or "Fri 28 Nov". */
		when: string;
		/** Shown open, with the sets ready to log. */
		open?: boolean;
		/** The trainer's guide to an exercise, by its name, or null when it has none yet. */
		guideFor: (name: string) => string | null;
		/** Posts a change to the workout and reloads. Resolves once done. */
		act: (body: Record<string, unknown>) => Promise<void>;
	}

	let { workout, when, open = false, guideFor, act }: Props = $props();

	// Extra sets added on this screen but not logged yet, per exercise.
	let extra = $state<Record<number, number>>({});

	function log(exercise: number, set: number, done: SetValues | null) {
		const { name } = workout.exercises[exercise];
		return act({ action: 'log', exercise, name, set, done }).then(() => {
			if (extra[exercise] && set >= workout.exercises[exercise].sets.length - 1) {
				extra[exercise] = Math.max(0, extra[exercise] - 1);
			}
		});
	}

	function plan(workout: WorkoutView): string {
		return workout.exercises.map((exercise) => exercise.name).join(', ');
	}
</script>

<details class="card" class:finished={!!workout.completedAt} {open}>
	<summary>
		<span class="head">
			<span class="when">{when}</span>
			<span class="title">{workout.title}</span>
			<span class="plan">{plan(workout)}</span>
		</span>
		<button
			class="icon"
			aria-label={`Talk to the trainer about ${workout.title}`}
			title="Talk to the trainer about this day"
			onclick={(event) => {
				event.preventDefault();
				attached.drop([{ id: workout.id, title: workout.title }]);
			}}
		>
			<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" /></svg>
		</button>
		<button
			class="icon delete"
			aria-label={`Delete ${workout.title}`}
			onclick={(event) => {
				event.preventDefault();
				act({ action: 'delete' });
			}}>×</button
		>
	</summary>

	{#if workout.details}
		<p class="advice">{workout.details}</p>
	{/if}

	{#if workout.warmup}
		<section class="warmup">
			<h3>Warm-up</h3>
			<p class="steps">{workout.warmup}</p>
		</section>
	{/if}

	<ol class="exercises">
		{#each workout.exercises as exercise, e (e + exercise.name)}
			{@const guide = guideFor(exercise.name)}
			<li>
				<div class="name">
					<span>{exercise.name}</span>
					{#if exercise.note}
						<span class="cue">{exercise.note}</span>
					{/if}
				</div>
				{#if guide}
					<details class="howto">
						<summary>How to do it</summary>
						<p class="steps">{guide}</p>
					</details>
				{/if}
				{#each exercise.sets as set, s (s)}
					<SetRow number={s + 1} {set} measure={exercise.measure} onlog={(done) => log(e, s, done)} />
				{/each}
				{#each { length: extra[e] ?? 0 } as _, k (k)}
					{@const s = exercise.sets.length + k}
					<SetRow
						number={s + 1}
						set={null}
						measure={exercise.measure}
						onlog={(done) => log(e, exercise.sets.length, done)}
					/>
				{/each}
				<button class="add" onclick={() => (extra[e] = (extra[e] ?? 0) + 1)}>+ Set</button>
			</li>
		{/each}
	</ol>

	<div class="actions">
		{#if workout.completedAt}
			<button onclick={() => act({ action: 'reopen' })}>Not finished</button>
		{:else}
			<button class="primary" onclick={() => act({ action: 'complete' })}>Finish workout</button>
		{/if}
	</div>
</details>

<style>
	.card {
		border-radius: 0.875rem;
		border: 1px solid var(--border);
		background: var(--surface);
		padding: 0.25rem 0.5rem 0.25rem 0.75rem;
	}

	.card[open] {
		padding-bottom: 0.75rem;
	}

	/* The exercises are listed in full once the card is open. */
	.card[open] .plan {
		display: none;
	}

	summary {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		list-style: none;
		cursor: pointer;
		padding: 0.35rem 0;
	}

	summary::-webkit-details-marker {
		display: none;
	}

	.head {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 0.05rem;
	}

	.when {
		font-size: 0.75rem;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.title {
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.finished .title {
		color: var(--muted);
	}

	.plan,
	.advice,
	.cue {
		font-size: 0.875rem;
		color: var(--muted);
		overflow-wrap: anywhere;
	}

	.plan {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.advice {
		margin: 0.25rem 0 0.5rem;
	}

	button {
		font: inherit;
		color: inherit;
		background: transparent;
		border: 0;
	}

	.icon {
		flex: none;
		width: 2.25rem;
		height: 2.25rem;
		display: grid;
		place-items: center;
		border-radius: 50%;
		color: var(--muted);
		font-size: 1.25rem;
		line-height: 1;
	}

	.icon svg {
		width: 1.125rem;
		height: 1.125rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.exercises {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.75rem;
	}

	.exercises > li {
		padding-top: 0.5rem;
		border-top: 1px solid var(--border);
	}

	.name {
		display: grid;
		gap: 0.05rem;
		margin-bottom: 0.15rem;
		font-weight: 600;
	}

	.cue {
		font-weight: 400;
	}

	/* The trainer writes one step per line. */
	.steps {
		margin: 0;
		white-space: pre-line;
		font-size: 0.875rem;
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.warmup {
		margin: 0 0 0.75rem;
		padding: 0.5rem 0.75rem;
		border-radius: 0.625rem;
		background: color-mix(in srgb, var(--accent) 8%, transparent);
	}

	.warmup h3 {
		margin: 0 0 0.25rem;
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--accent);
	}

	.howto {
		margin: 0 0 0.25rem;
	}

	.howto summary {
		display: inline-block;
		padding: 0.15rem 0;
		font-size: 0.8125rem;
		color: var(--accent);
	}

	.howto[open] summary {
		margin-bottom: 0.15rem;
	}

	.howto .steps {
		padding: 0.4rem 0.6rem;
		border-left: 2px solid var(--border);
		color: var(--muted);
	}

	.add {
		margin-top: 0.15rem;
		padding: 0.2rem 0;
		font-size: 0.8125rem;
		color: var(--accent);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 0.75rem;
	}

	.actions button {
		padding: 0.4rem 0.9rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		font-size: 0.875rem;
	}

	.actions .primary {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--on-accent);
	}
</style>
