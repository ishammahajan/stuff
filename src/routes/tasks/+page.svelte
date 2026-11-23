<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { attached } from '#lib/attached.svelte.ts';
	import { describeRepeat, localDate, type TaskView } from '#lib/items.ts';
	import { recent } from '#lib/recent.svelte.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// A completed task stays in its place this long, then moves to the archive.
	const ARCHIVE_AFTER_MS = 10 * 60 * 1000;
	// A press on a selected task that moves this far is a drag, not a tap.
	const DRAG_PX = 8;
	const DAY_MS = 24 * 60 * 60 * 1000;

	let now = $state(Date.now());
	let today = $derived(localDate(new Date(now)));
	const selected = new SvelteSet<string>();
	let message = $state('');
	/** The last tap change that can't simply be tapped back, with its Undo. */
	let toast = $state<{ text: string; operationId: string } | null>(null);
	/** Where the dragged selection is, while dragging. */
	let drag = $state<{ x: number; y: number } | null>(null);

	const isArchived = (task: TaskView) =>
		task.completedAt !== null && now - Date.parse(task.completedAt) >= ARCHIVE_AFTER_MS;

	// Important first, then by date (undated last), then by title. Completion doesn't
	// change the order, so a task stays where it was when it is checked off.
	function compare(a: TaskView, b: TaskView): number {
		if (a.important !== b.important) return a.important ? -1 : 1;
		if (a.date !== b.date) return (a.date ?? '9999') < (b.date ?? '9999') ? -1 : 1;
		return a.title.localeCompare(b.title);
	}

	let sections = $derived.by(() => {
		const shown = data.tasks.filter((task) => !isArchived(task)).sort(compare);
		return [
			{ name: 'Overdue', tasks: shown.filter((task) => task.date && task.date < today) },
			{ name: 'Today', tasks: shown.filter((task) => task.date === today) },
			{ name: 'Upcoming', tasks: shown.filter((task) => task.date && task.date > today) },
			{ name: 'No date', tasks: shown.filter((task) => !task.date) }
		].filter((section) => section.tasks.length > 0);
	});

	let archived = $derived(
		data.tasks
			.filter(isArchived)
			.sort((a, b) => Date.parse(b.completedAt!) - Date.parse(a.completedAt!))
	);

	function dateLabel(date: string): string {
		const days = Math.round((Date.parse(date) - Date.parse(today)) / DAY_MS);
		if (days === 0) return 'Today';
		if (days === 1) return 'Tomorrow';
		if (days === -1) return 'Yesterday';
		const day = new Date(`${date}T00:00:00`);
		if (days > 1 && days < 7) return day.toLocaleDateString(undefined, { weekday: 'long' });
		const sameYear = date.slice(0, 4) === today.slice(0, 4);
		return day.toLocaleDateString(undefined, {
			day: 'numeric',
			month: 'short',
			year: sameYear ? undefined : 'numeric'
		});
	}

	function timeLabel(local: string): string {
		return new Date(`${local}:00`).toLocaleTimeString(undefined, {
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	function meta(task: TaskView): string {
		const reminder = task.remindAt
			? `Reminder ${task.remindAt.slice(0, 10) === task.date ? '' : `${dateLabel(task.remindAt.slice(0, 10))} `}${timeLabel(task.remindAt)}`
			: '';
		return [
			task.date ? dateLabel(task.date) : '',
			reminder,
			task.repeat ? describeRepeat(task.repeat) : '',
			...task.tags.map((tag) => `#${tag}`)
		]
			.filter(Boolean)
			.join(' · ');
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

	async function change(task: TaskView, action: 'complete' | 'reopen' | 'delete') {
		const reply = await post(`/api/tasks/${task.id}`, { action, localDate: localDate() });
		if (reply && typeof reply.operationId === 'string') {
			// Checking off a one-off task can be tapped back, so only these get an Undo.
			if (action === 'delete') {
				toast = { text: `Deleted: ${task.title}`, operationId: reply.operationId };
				selected.delete(task.id);
			} else if (action === 'complete' && task.repeat) {
				toast = { text: `Done, and moved to the next date: ${task.title}`, operationId: reply.operationId };
			} else {
				toast = null;
			}
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

	function selectedItems() {
		return data.tasks
			.filter((task) => selected.has(task.id))
			.map((task) => ({ id: task.id, title: task.title }));
	}

	function talkAbout() {
		attached.drop(selectedItems());
		selected.clear();
	}

	// Dragging: a press on a selected task that moves becomes a drag of the whole
	// selection. Dropping it on the pill attaches the tasks and starts recording.
	let press: { x: number; y: number } | null = null;
	let dragged = false;

	function onpointerdown(event: PointerEvent, task: TaskView) {
		dragged = false;
		if (!event.isPrimary || !selected.has(task.id)) return;
		if ((event.target as HTMLElement).closest('.check, .edit, .delete')) return;
		press = { x: event.clientX, y: event.clientY };
		try {
			(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		} catch {
			// The pointer is already gone.
		}
	}

	function onpointermove(event: PointerEvent) {
		if (!press) return;
		if (!drag && Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_PX) return;
		drag = { x: event.clientX, y: event.clientY };
		attached.hovering = attached.isOverPill(event.clientX, event.clientY);
	}

	function onpointerup(event: PointerEvent) {
		if (!press) return;
		press = null;
		if (!drag) return;
		dragged = true;
		drag = null;
		if (attached.isOverPill(event.clientX, event.clientY)) talkAbout();
		attached.hovering = false;
	}

	function onpointercancel() {
		press = null;
		drag = null;
		attached.hovering = false;
	}

	function toggle(task: TaskView) {
		// The click that ends a drag isn't a tap.
		if (dragged) {
			dragged = false;
			return;
		}
		if (selected.has(task.id)) selected.delete(task.id);
		else selected.add(task.id);
	}

	// Drops selected tasks that no longer exist.
	$effect(() => {
		const ids = new Set(data.tasks.map((task) => task.id));
		for (const id of selected) if (!ids.has(id)) selected.delete(id);
	});

	// Reloads the tasks when a capture finishes, since it may have changed them.
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
		attached.screen = 'task';
		recent.refresh();
		// Moves completed tasks to the archive as they age, and keeps "today" current.
		const timer = setInterval(() => (now = Date.now()), 15_000);
		return () => {
			clearInterval(timer);
			attached.screen = null;
			attached.hovering = false;
		};
	});
</script>

<svelte:head>
	<title>Tasks</title>
</svelte:head>

{#snippet row(task: TaskView)}
	<li
		class:selected={selected.has(task.id)}
		class:done={task.completedAt !== null}
		onpointerdown={(event) => onpointerdown(event, task)}
		{onpointermove}
		{onpointerup}
		{onpointercancel}
	>
		<button
			class="check"
			aria-label={task.completedAt ? `Reopen ${task.title}` : `Complete ${task.title}`}
			aria-pressed={task.completedAt !== null}
			onclick={() => change(task, task.completedAt ? 'reopen' : 'complete')}
		>
			{#if task.completedAt}✓{/if}
		</button>
		<button class="body" aria-pressed={selected.has(task.id)} onclick={() => toggle(task)}>
			<span class="title">
				{#if task.important}<span class="important" aria-label="Important">!</span>{/if}
				{task.title}
			</span>
			{#if task.details}
				<span class="details">{task.details}</span>
			{/if}
			{#if meta(task)}
				<span class="meta" class:overdue={!task.completedAt && task.date && task.date < today}
					>{meta(task)}</span
				>
			{/if}
		</button>
		<button
			class="edit"
			aria-label={`Edit ${task.title} by voice`}
			title="Edit by voice"
			onclick={() => attached.drop([{ id: task.id, title: task.title }])}
		>
			<svg viewBox="0 0 24 24" aria-hidden="true">
				<path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" />
			</svg>
		</button>
		<button class="delete" aria-label={`Delete ${task.title}`} onclick={() => change(task, 'delete')}
			>×</button
		>
	</li>
{/snippet}

<main>
	<header>
		<a href="/">‹ Stuff</a>
		<a href="/tasks/calendar">Calendar alarms</a>
	</header>

	<h1>Tasks</h1>

	{#if selected.size > 0}
		<div class="selection">
			<span>{selected.size} selected. Drag onto the pill, or</span>
			<button class="primary" onclick={talkAbout}>Talk about {selected.size === 1 ? 'it' : 'them'}</button>
			<button onclick={() => selected.clear()}>Clear</button>
		</div>
	{/if}

	{#if message}
		<p class="error" role="alert">{message}</p>
	{/if}

	{#if toast}
		<p class="toast" role="status">
			<span>{toast.text}</span>
			<button onclick={undo}>Undo</button>
		</p>
	{/if}

	{#if sections.length === 0}
		<p class="muted">
			No open tasks. Say something like “remind me to call the bank on Friday”.
		</p>
	{/if}

	{#each sections as section (section.name)}
		<section>
			<h2>{section.name}</h2>
			<ul>
				{#each section.tasks as task (task.id)}
					{@render row(task)}
				{/each}
			</ul>
		</section>
	{/each}

	{#if archived.length > 0}
		<details>
			<summary>Archive ({archived.length})</summary>
			<ul>
				{#each archived as task (task.id)}
					{@render row(task)}
				{/each}
			</ul>
		</details>
	{/if}
</main>

{#if drag}
	<div class="ghost" style:left="{drag.x}px" style:top="{drag.y}px">
		{selected.size === 1 ? '1 task' : `${selected.size} tasks`}
	</div>
{/if}

<style>
	main {
		max-width: 40rem;
		margin: 0 auto;
		padding: 1.25rem 1rem 2rem;
	}

	header {
		display: flex;
		justify-content: space-between;
		margin-bottom: 1rem;
	}

	a {
		color: var(--accent);
		text-decoration: none;
	}

	h2,
	summary {
		font-size: 0.8125rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted);
		margin: 1.25rem 0 0.5rem;
	}

	summary {
		cursor: pointer;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}

	li {
		display: flex;
		align-items: flex-start;
		gap: 0.25rem;
		padding: 0.5rem;
		border-radius: 0.875rem;
		border: 1px solid var(--border);
		background: var(--surface);
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
	}

	/* A selected task is dragged, not scrolled, so the drag works on touch screens. */
	li.selected {
		border-color: var(--accent);
		box-shadow: 0 0 0 1px var(--accent);
		touch-action: none;
	}

	li.done .title,
	li.done .details {
		text-decoration: line-through;
		color: var(--muted);
	}

	button {
		font: inherit;
		color: inherit;
		background: transparent;
		border: 0;
	}

	.check {
		flex: none;
		width: 1.5rem;
		height: 1.5rem;
		margin: 0.4rem;
		border-radius: 50%;
		border: 2px solid var(--muted);
		color: var(--on-accent);
		font-size: 0.875rem;
		line-height: 1;
	}

	li.done .check {
		background: var(--accent);
		border-color: var(--accent);
	}

	.body {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 0.1rem;
		padding: 0.35rem 0.25rem;
		text-align: left;
	}

	.title {
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.important {
		color: var(--danger);
		margin-right: 0.15rem;
	}

	.details,
	.meta {
		font-size: 0.875rem;
		color: var(--muted);
		overflow-wrap: anywhere;
	}

	.details {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.meta.overdue {
		color: var(--danger);
	}

	.edit,
	.delete {
		flex: none;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 50%;
		color: var(--muted);
		font-size: 1.25rem;
		line-height: 1;
	}

	.edit {
		display: grid;
		place-items: center;
	}

	.edit svg {
		width: 1.125rem;
		height: 1.125rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.selection,
	.toast {
		position: sticky;
		top: 0.5rem;
		z-index: 5;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0 0.75rem;
		padding: 0.5rem 0.75rem;
		border-radius: 0.875rem;
		border: 1px solid var(--accent);
		background: var(--surface);
		font-size: 0.875rem;
	}

	.toast {
		border-color: var(--border);
		justify-content: space-between;
	}

	.toast span {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.selection button,
	.toast button {
		padding: 0.25rem 0.7rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		font-size: 0.8125rem;
	}

	.selection button.primary {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--on-accent);
	}

	.ghost {
		position: fixed;
		z-index: 20;
		transform: translate(-50%, -150%);
		padding: 0.3rem 0.75rem;
		border-radius: 999px;
		background: var(--accent);
		color: var(--on-accent);
		font-size: 0.875rem;
		font-weight: 600;
		pointer-events: none;
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.2);
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
