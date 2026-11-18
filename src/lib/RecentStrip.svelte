<script lang="ts">
	import { onMount } from 'svelte';
	import OperationList from '#lib/OperationList.svelte';
	import { recent } from '#lib/recent.svelte.ts';

	// Results older than this stay in the inbox only.
	const MAX_AGE_MS = 24 * 60 * 60 * 1000;

	let shown = $derived(
		recent.captures.filter((capture) => Date.now() - capture.createdAt.getTime() < MAX_AGE_MS)
	);

	onMount(() => {
		recent.refresh();
	});
</script>

{#if shown.length > 0 || recent.message}
	<section aria-label="Recent recordings">
		{#if recent.message}
			<p class="error" role="alert">{recent.message}</p>
		{/if}
		{#each shown as capture (capture.id)}
			<div class="result" class:failed={capture.status === 'failed'}>
				{#if capture.status === 'pending'}
					<p class="muted">Processing a recording…</p>
				{:else if capture.status === 'failed'}
					<p>A recording couldn't be read. <a href="/inbox">Retry in inbox</a></p>
				{:else if capture.operations.length === 0}
					<p class="muted">
						{#if capture.transcript}
							Nothing to file in “{capture.transcript}”
						{:else}
							Nothing was recognized in a recording.
						{/if}
					</p>
				{:else}
					<OperationList operations={capture.operations} onundo={(id) => recent.undo(id)} />
				{/if}
			</div>
		{/each}
		<a class="all" href="/inbox">All recordings</a>
	</section>
{/if}

<style>
	section {
		display: grid;
		gap: 0.5rem;
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
	}

	.all {
		justify-self: center;
		font-size: 0.875rem;
		text-decoration: none;
	}
</style>
