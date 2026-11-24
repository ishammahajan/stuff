<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import { attached } from '#lib/attached.svelte.ts';
	import { localDate, type NoteView } from '#lib/items.ts';
	import { recent } from '#lib/recent.svelte.ts';
	import { Selection } from '#lib/selection.svelte.ts';
	import SelectionBar from '#lib/SelectionBar.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const selection = new Selection(() => data.notes.map(({ id, title }) => ({ id, title })));
	let message = $state('');
	/** The last deleted note, with its Undo. */
	let toast = $state<{ text: string; operationId: string } | null>(null);

	// Each list, alphabetically; then notes made from PDFs; then the other notes.
	// Notes arrive newest first, and each section keeps that order.
	let sections = $derived.by(() => {
		const lists = new Map<string, NoteView[]>();
		const documents: NoteView[] = [];
		const other: NoteView[] = [];
		for (const note of data.notes) {
			if (note.list) {
				const key = note.list.toLowerCase();
				if (!lists.has(key)) lists.set(key, []);
				lists.get(key)!.push(note);
			} else if (note.passages > 0) documents.push(note);
			else other.push(note);
		}
		return [
			...[...lists.values()]
				.map((notes) => ({ name: notes[0].list!, notes }))
				.sort((a, b) => a.name.localeCompare(b.name)),
			{ name: 'Documents', notes: documents },
			{ name: lists.size > 0 || documents.length > 0 ? 'Other notes' : 'Notes', notes: other }
		].filter((section) => section.notes.length > 0);
	});

	function meta(note: NoteView): string {
		const created = new Date(note.createdAt).toLocaleDateString(undefined, {
			day: 'numeric',
			month: 'short'
		});
		return [
			note.passages > 0 ? `PDF · ${note.passages} ${note.passages === 1 ? 'passage' : 'passages'}` : '',
			created,
			...note.tags.map((tag) => `#${tag}`)
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

	async function remove(note: NoteView) {
		const reply = await post(`/api/notes/${note.id}`, { action: 'delete', localDate: localDate() });
		if (reply && typeof reply.operationId === 'string') {
			// Undo brings back the note, but not the PDF text it was searched by.
			const text =
				note.passages > 0
					? `Deleted: ${note.title}. Undo brings back the note, not the PDF text.`
					: `Deleted: ${note.title}`;
			toast = { text, operationId: reply.operationId };
			selection.selected.delete(note.id);
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

	// Drops selected notes that no longer exist.
	$effect(() => selection.prune(data.notes.map((note) => note.id)));

	// Reloads the notes when a capture finishes, since it may have changed them.
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
		attached.screen = 'note';
		recent.refresh();
		return () => {
			attached.screen = null;
			attached.hovering = false;
		};
	});
</script>

<svelte:head>
	<title>Knowledge</title>
</svelte:head>

<main>
	<header>
		<a href="/">‹ Stuff</a>
	</header>

	<h1>Knowledge</h1>

	<SelectionBar {selection} noun={['note', 'notes']} />

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
			No notes yet. Say something like “add Dune to my movies list”, or send a PDF with the +.
		</p>
	{/if}

	{#each sections as section (section.name)}
		<section>
			<h2>{section.name}</h2>
			<ul>
				{#each section.notes as note (note.id)}
					<li
						class:selected={selection.selected.has(note.id)}
						{...selection.handlers(note.id, '.edit, .delete')}
					>
						<button
							class="body"
							aria-pressed={selection.selected.has(note.id)}
							onclick={() => selection.toggle(note.id)}
						>
							<span class="title">{note.title}</span>
							{#if note.details}
								<span class="details">{note.details}</span>
							{/if}
							<span class="meta">{meta(note)}</span>
						</button>
						<button
							class="edit"
							aria-label={`Edit ${note.title} by voice`}
							title="Edit by voice"
							onclick={() => attached.drop([{ id: note.id, title: note.title }])}
						>
							<svg viewBox="0 0 24 24" aria-hidden="true">
								<path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" />
							</svg>
						</button>
						<button class="delete" aria-label={`Delete ${note.title}`} onclick={() => remove(note)}
							>×</button
						>
					</li>
				{/each}
			</ul>
		</section>
	{/each}
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
		padding: 0.5rem 0.5rem 0.5rem 0.75rem;
		border-radius: 0.875rem;
		border: 1px solid var(--border);
		background: var(--surface);
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
	}

	/* A selected note is dragged, not scrolled, so the drag works on touch screens. */
	li.selected {
		border-color: var(--accent);
		box-shadow: 0 0 0 1px var(--accent);
		touch-action: none;
	}

	button {
		font: inherit;
		color: inherit;
		background: transparent;
		border: 0;
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

	.details,
	.meta {
		font-size: 0.875rem;
		color: var(--muted);
		overflow-wrap: anywhere;
	}

	.details {
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
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
