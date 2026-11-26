<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import { attached } from '#lib/attached.svelte.ts';
	import {
		addDays,
		anyDone,
		localDate,
		MUSCLES,
		type GoalView,
		type TrainerNoteView,
		type WorkoutView
	} from '#lib/items.ts';
	import { recent } from '#lib/recent.svelte.ts';
	import GoalCard from './GoalCard.svelte';
	import ProgressChart from './ProgressChart.svelte';
	import WorkoutCard from './WorkoutCard.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const HISTORY_LIMIT = 20;

	let message = $state('');
	/** The last deletion, with its Undo. */
	let toast = $state<{ text: string; operationId: string } | null>(null);

	const dateOf = (workout: WorkoutView) => workout.date ?? workout.createdAt.slice(0, 10);

	// Grouping runs in the browser, which knows the local date. A workout counts as
	// done once it is finished or any of its sets was logged on a past day.
	let groups = $derived.by(() => {
		const today = localDate();
		const byDate = (a: WorkoutView, b: WorkoutView) => dateOf(a).localeCompare(dateOf(b));
		const done = (w: WorkoutView) =>
			!!w.completedAt || (dateOf(w) < today && anyDone(w.exercises));
		return {
			today: data.workouts.filter((w) => !done(w) && dateOf(w) === today),
			missed: data.workouts.filter((w) => !done(w) && dateOf(w) < today).sort(byDate),
			upcoming: data.workouts.filter((w) => !done(w) && dateOf(w) > today).sort(byDate),
			history: data.workouts
				.filter(done)
				.sort((a, b) => byDate(b, a))
				.slice(0, HISTORY_LIMIT)
		};
	});

	// Open goals, then those reached, newest first. A goal reached in the last day is
	// highlighted.
	const DAY = 86_400_000;
	let goals = $derived({
		open: data.goals.filter((g) => !g.completedAt),
		reached: data.goals
			.filter((g) => g.completedAt)
			.sort((a, b) => b.completedAt!.localeCompare(a.completedAt!))
	});
	const fresh = (goal: GoalView) => !!goal.completedAt && Date.now() - Date.parse(goal.completedAt) < DAY;

	// Done sets per muscle in the last 7 days, most first.
	let muscles = $derived.by(() => {
		const today = localDate();
		const from = addDays(today, -6);
		const sets = new Map<string, number>();
		for (const workout of data.workouts) {
			const date = dateOf(workout);
			if (date < from || date > today) continue;
			for (const exercise of workout.exercises) {
				const count = exercise.sets.filter((set) => set.done).length;
				for (const muscle of exercise.muscles) sets.set(muscle, (sets.get(muscle) ?? 0) + count);
			}
		}
		const trained = MUSCLES.filter((m) => (sets.get(m) ?? 0) > 0)
			.map((muscle) => ({ muscle, sets: sets.get(muscle)! }))
			.sort((a, b) => b.sets - a.sets);
		return {
			trained,
			most: Math.max(1, ...trained.map((m) => m.sets)),
			untrained: MUSCLES.filter((m) => !sets.get(m))
		};
	});

	// Each exercise's guide, by its name in lower case.
	let guides = $derived(new Map(data.guides.map((g) => [g.name.trim().toLowerCase(), g.guide])));
	const guideFor = (name: string) => guides.get(name.trim().toLowerCase()) ?? null;

	const label = (value: string) => value.replace(/_/g, ' ');

	function when(workout: WorkoutView): string {
		const date = dateOf(workout);
		const today = localDate();
		if (date === today) return 'Today';
		if (date === addDays(today, 1)) return 'Tomorrow';
		if (date === addDays(today, -1)) return 'Yesterday';
		const [y, m, d] = date.split('-').map(Number);
		return new Date(y, m - 1, d).toLocaleDateString(undefined, {
			weekday: 'short',
			day: 'numeric',
			month: 'short'
		});
	}

	async function post(url: string, body?: unknown): Promise<Record<string, unknown> | null> {
		message = '';
		const response = await fetch(url, {
			method: 'POST',
			headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		}).catch(() => null);
		if (!response) {
			message = 'Could not reach the server. Try again.';
			return null;
		}
		const reply = await response.json().catch(() => ({}));
		if (!response.ok) {
			message = reply?.message ?? `That didn't work (${response.status}).`;
			return null;
		}
		return reply;
	}

	/** Changes a workout from a tap, then reloads. Deleting offers an Undo. */
	async function act(workout: WorkoutView, body: Record<string, unknown>) {
		const reply = await post(`/api/workouts/${workout.id}`, { ...body, localDate: localDate() });
		if (reply && body.action === 'delete' && typeof reply.operationId === 'string') {
			toast = { text: `Deleted: ${workout.title}`, operationId: reply.operationId };
		}
		await invalidateAll();
	}

	async function forget(note: TrainerNoteView) {
		const reply = await post(`/api/trainer-notes/${note.id}`, {
			action: 'delete',
			localDate: localDate()
		});
		if (reply && typeof reply.operationId === 'string') {
			toast = { text: `Forgot: ${note.title}`, operationId: reply.operationId };
		}
		await invalidateAll();
	}

	async function dropGoal(goal: GoalView) {
		const reply = await post(`/api/goals/${goal.id}`, { action: 'delete', localDate: localDate() });
		if (reply && typeof reply.operationId === 'string') {
			toast = { text: `Deleted goal: ${goal.title}`, operationId: reply.operationId };
		}
		await invalidateAll();
	}

	async function undo() {
		if (!toast) return;
		const { operationId } = toast;
		toast = null;
		await post(`/api/operations/${operationId}/undo`);
		await invalidateAll();
	}

	// Reloads when a capture finishes, since the trainer may have changed the plan.
	let seen: string | null = null;
	$effect(() => {
		const key = recent.captures
			.filter((capture) => capture.status !== 'pending')
			.map((capture) => capture.id)
			.join(',');
		if (seen !== null && key !== seen) invalidateAll();
		seen = key;
	});

	onMount(() => {
		attached.screen = 'workout';
		recent.refresh();
		return () => {
			attached.screen = null;
			attached.hovering = false;
		};
	});
</script>

<svelte:head>
	<title>Gym</title>
</svelte:head>

<main>
	<header>
		<a href="/">‹ Stuff</a>
	</header>

	<h1>Gym</h1>

	{#if message}
		<p class="error" role="alert">{message}</p>
	{/if}

	{#if toast}
		<p class="toast" role="status">
			<span>{toast.text}</span>
			<button onclick={undo}>Undo</button>
		</p>
	{/if}

	{#if data.workouts.length === 0}
		<p class="muted">
			Talk to your trainer with the pill. Try “I have dumbbells up to 10 kg at home”, then
			“plan a calibration workout for today” or “plan my next 3 days at home”.
		</p>
	{/if}

	{#snippet group(title: string, workouts: WorkoutView[], open: boolean)}
		{#if workouts.length > 0}
			<section>
				<h2>{title}</h2>
				<div class="list">
					{#each workouts as workout (workout.id)}
						<WorkoutCard
							{workout}
							when={when(workout)}
							{open}
							{guideFor}
							act={(body) => act(workout, body)}
						/>
					{/each}
				</div>
			</section>
		{/if}
	{/snippet}

	{@render group('Today', groups.today, true)}

	{#if data.goals.length > 0}
		<section>
			<h2>Goals</h2>
			<ul class="goals">
				{#each [...goals.open, ...goals.reached] as goal (goal.id)}
					<GoalCard {goal} fresh={fresh(goal)} ondelete={() => dropGoal(goal)} />
				{/each}
			</ul>
		</section>
	{/if}

	{@render group('Missed', groups.missed, false)}
	{@render group('Upcoming', groups.upcoming, false)}
	{@render group('Done', groups.history, false)}

	{#if data.progress.length > 0}
		<section>
			<h2>Progress</h2>
			<ProgressChart
				series={data.progress}
				initial={data.progress.find((s) =>
					goals.open.some((g) => g.goal.exercise.toLowerCase() === s.name.toLowerCase())
				)?.name}
			/>
		</section>

		<section>
			<h2>Sets per muscle, last 7 days</h2>
			{#if muscles.trained.length === 0}
				<p class="muted">No sets logged this week.</p>
			{:else}
				<ul class="muscles">
					{#each muscles.trained as { muscle, sets } (muscle)}
						<li>
							<span class="muscle">{label(muscle)}</span>
							<span class="track"><span style:width={`${(sets / muscles.most) * 100}%`}></span></span>
							<span class="count">{sets}</span>
						</li>
					{/each}
				</ul>
				{#if muscles.untrained.length > 0}
					<p class="muted small">Not trained: {muscles.untrained.map(label).join(', ')}.</p>
				{/if}
			{/if}
		</section>
	{/if}

	<section>
		<h2>Trainer notes</h2>
		{#if data.notes.length === 0}
			<p class="muted">
				Nothing yet. The trainer remembers equipment, goals, injuries, and what it notices.
			</p>
		{:else}
			<ul class="notes">
				{#each data.notes as note (note.id)}
					<li>
						<span class="note">
							{note.title}
							{#if note.details}
								<span class="details">{note.details}</span>
							{/if}
						</span>
						<button class="forget" aria-label={`Forget: ${note.title}`} onclick={() => forget(note)}
							>×</button
						>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</main>

<style>
	main {
		max-width: 40rem;
		margin: 0 auto;
		padding: 1.25rem 1rem 2rem;
	}

	header {
		margin-bottom: 1rem;
	}

	a {
		color: var(--accent);
		text-decoration: none;
	}

	h2 {
		font-size: 0.8125rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted);
		margin: 1.25rem 0 0.5rem;
	}

	.list,
	.notes,
	.goals {
		display: grid;
		gap: 0.5rem;
	}

	.notes,
	.goals,
	.muscles {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.muscles {
		display: grid;
		gap: 0.35rem;
		padding: 0.6rem 0.75rem;
		border-radius: 0.875rem;
		border: 1px solid var(--border);
		background: var(--surface);
	}

	.muscles li {
		display: grid;
		grid-template-columns: 6.5rem 1fr 2rem;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
	}

	.muscle {
		text-transform: capitalize;
		overflow-wrap: anywhere;
	}

	.track span {
		display: block;
		height: 0.625rem;
		border-radius: 0 4px 4px 0;
		background: var(--accent);
	}

	.count {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.small {
		margin-top: 0.5rem;
		font-size: 0.8125rem;
	}

	.notes li {
		display: flex;
		align-items: flex-start;
		gap: 0.25rem;
		padding: 0.5rem 0.5rem 0.5rem 0.75rem;
		border-radius: 0.875rem;
		border: 1px solid var(--border);
		background: var(--surface);
	}

	.note {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 0.1rem;
		padding: 0.35rem 0;
		overflow-wrap: anywhere;
	}

	.details {
		font-size: 0.875rem;
		color: var(--muted);
	}

	button {
		font: inherit;
		color: inherit;
		background: transparent;
		border: 0;
	}

	.forget {
		flex: none;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 50%;
		color: var(--muted);
		font-size: 1.25rem;
		line-height: 1;
	}

	.toast {
		position: sticky;
		top: 0.5rem;
		z-index: 5;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin: 0 0 0.75rem;
		padding: 0.5rem 0.75rem;
		border-radius: 0.875rem;
		border: 1px solid var(--border);
		background: var(--surface);
		font-size: 0.875rem;
	}

	.toast span {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.toast button {
		padding: 0.25rem 0.7rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		font-size: 0.8125rem;
	}

	p {
		margin: 0 0 0.75rem;
	}

	.muted {
		color: var(--muted);
	}

	.error {
		color: var(--danger);
	}
</style>
