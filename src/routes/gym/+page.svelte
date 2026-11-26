<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import { attached } from '#lib/attached.svelte.ts';
	import { addDays, anyDone, localDate, type TrainerNoteView, type WorkoutView } from '#lib/items.ts';
	import { recent } from '#lib/recent.svelte.ts';
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
						<WorkoutCard {workout} when={when(workout)} {open} act={(body) => act(workout, body)} />
					{/each}
				</div>
			</section>
		{/if}
	{/snippet}

	{@render group('Today', groups.today, true)}
	{@render group('Missed', groups.missed, false)}
	{@render group('Upcoming', groups.upcoming, false)}
	{@render group('Done', groups.history, false)}

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
	.notes {
		display: grid;
		gap: 0.5rem;
	}

	.notes {
		list-style: none;
		margin: 0;
		padding: 0;
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
