<script lang="ts">
	import OperationList from '#lib/OperationList.svelte';
	import Question from '#lib/Question.svelte';
	import { recent } from '#lib/recent.svelte.ts';

	// Results older than this stay in the inbox only. Open questions always show.
	const MAX_AGE_MS = 24 * 60 * 60 * 1000;

	let shown = $derived(
		recent.captures.filter(
			(capture) =>
				capture.status === 'asking' || Date.now() - capture.createdAt.getTime() < MAX_AGE_MS
		)
	);
</script>

<section id="recent-panel" aria-label="Recent recordings">
	<header>
		<h2>Recent</h2>
		<a href="/inbox" onclick={() => (recent.open = false)}>All recordings</a>
	</header>
	<div class="list">
		{#if recent.message}
			<p class="error" role="alert">{recent.message}</p>
		{/if}
		{#each shown as capture (capture.id)}
			<div
				class="result"
				class:failed={capture.status === 'failed'}
				class:asking={capture.status === 'asking'}
			>
				{#if capture.status === 'pending'}
					<p class="muted">
						{capture.fileName ? `Reading “${capture.fileName}”…` : 'Processing a recording…'}
					</p>
				{:else if capture.status === 'failed'}
					<p>
						{capture.fileName
							? `“${capture.fileName}” couldn't be read.`
							: "A recording couldn't be read."}
						<a href="/inbox" onclick={() => (recent.open = false)}>Retry in inbox</a>
					</p>
				{:else if capture.question}
					<div class="stack">
						{#if capture.operations.length > 0}
							<OperationList operations={capture.operations} onundo={(id) => recent.undo(id)} />
						{/if}
						<Question captureId={capture.id} question={capture.question} />
					</div>
				{:else if capture.operations.length === 0}
					<p class="muted">
						{#if capture.transcript || capture.fileName}
							Nothing to file in “{capture.transcript || capture.fileName}”
						{:else}
							Nothing was recognized in a recording.
						{/if}
					</p>
				{:else}
					<OperationList operations={capture.operations} onundo={(id) => recent.undo(id)} />
				{/if}
			</div>
		{:else}
			<p class="muted">Nothing recorded in the last day.</p>
		{/each}
	</div>
</section>

<style>
	section {
		width: min(40rem, calc(100vw - 2rem));
		display: grid;
		grid-template-rows: auto minmax(0, 1fr);
		/* Leaves the top of the screen visible, so it's clear this is a window over the page. */
		max-height: min(32rem, 55dvh);
		border-radius: 1.25rem;
		border: 1px solid var(--border);
		background: var(--bg);
		box-shadow: 0 8px 32px rgb(0 0 0 / 0.25);
		overflow: hidden;
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.6rem 1rem;
		border-bottom: 1px solid var(--border);
	}

	h2 {
		margin: 0;
		font-size: 0.9375rem;
	}

	.list {
		display: grid;
		align-content: start;
		gap: 0.5rem;
		padding: 0.75rem;
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.result {
		padding: 0.75rem 1rem;
		border-radius: 1rem;
		border: 1px solid var(--border);
		background: var(--surface);
	}

	.result.failed {
		border-color: var(--danger);
	}

	.result.asking {
		border-color: var(--accent);
	}

	.stack {
		display: grid;
		gap: 0.75rem;
	}

	p {
		margin: 0;
		overflow-wrap: anywhere;
	}

	.muted {
		color: var(--muted);
	}

	.error {
		color: var(--danger);
	}

	a {
		color: var(--accent);
		font-size: 0.875rem;
		text-decoration: none;
	}
</style>
