<script lang="ts">
	import { enhance } from '$app/forms';
	import OperationList from '#lib/OperationList.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
</script>

<svelte:head>
	<title>Inbox</title>
</svelte:head>

<main>
	<header>
		<a href="/">‹ Stuff</a>
	</header>

	<h1>Inbox</h1>

	{#if form?.message}
		<p class="error" role="alert">{form.message}</p>
	{/if}

	{#if data.captures.length === 0}
		<p class="muted">Nothing captured yet.</p>
	{/if}

	{#each data.captures as capture (capture.id)}
		<article>
			<div class="top">
				<time datetime={capture.createdAt.toISOString()}>
					{formatter.format(capture.createdAt)}
				</time>
				<div class="actions">
					{#if capture.status !== 'done'}
						<form method="POST" action="?/retry" use:enhance>
							<input type="hidden" name="id" value={capture.id} />
							<button type="submit">Retry</button>
						</form>
					{/if}
					<form method="POST" action="?/delete" use:enhance>
						<input type="hidden" name="id" value={capture.id} />
						<button type="submit">Delete</button>
					</form>
				</div>
			</div>

			{#if capture.status === 'failed'}
				<p class="error">Couldn't be read: {capture.error}</p>
			{:else if capture.status === 'pending'}
				<p class="muted">Not processed yet.</p>
			{:else}
				<OperationList operations={capture.operations} />
			{/if}

			{#if capture.transcript}
				<p class="quote">“{capture.transcript}”</p>
			{/if}
		</article>
	{/each}
</main>

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

	article {
		display: grid;
		gap: 0.75rem;
		padding: 1rem;
		margin-bottom: 0.75rem;
		border-radius: 1rem;
		border: 1px solid var(--border);
		background: var(--surface);
	}

	.top {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
	}

	time {
		font-size: 0.875rem;
		color: var(--muted);
	}

	.actions {
		display: flex;
		gap: 0.5rem;
	}

	button {
		font: inherit;
		font-size: 0.8125rem;
		padding: 0.25rem 0.6rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--muted);
	}

	p {
		margin: 0;
	}

	.muted,
	.quote {
		color: var(--muted);
	}

	.quote {
		font-size: 0.875rem;
		overflow-wrap: anywhere;
	}

	.error {
		color: var(--danger);
		overflow-wrap: anywhere;
	}
</style>
