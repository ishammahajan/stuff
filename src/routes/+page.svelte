<script lang="ts">
	import RecentStrip from '#lib/RecentStrip.svelte';

	// Utilities shown on the dashboard. Give a tile an `href` when its utility exists.
	const tiles: { name: string; description: string; href?: string }[] = [
		{ name: 'Inbox', description: 'Review what was captured', href: '/inbox' },
		{ name: 'Tasks', description: 'Things to do', href: '/tasks' },
		{ name: 'Knowledge', description: 'Ideas and recommendations' },
		{ name: 'Budget', description: 'Spending and income' }
	];
</script>

<svelte:head>
	<title>Stuff</title>
</svelte:head>

<main>
	<header>
		<h1>Stuff</h1>
		<form method="POST" action="/logout">
			<button type="submit" class="signout">Sign out</button>
		</form>
	</header>

	<ul>
		{#each tiles as tile (tile.name)}
			<li>
				{#if tile.href}
					<a class="tile" href={tile.href}>
						<span class="name">{tile.name}</span>
						<span class="description">{tile.description}</span>
					</a>
				{:else}
					<div class="tile soon">
						<span class="name">{tile.name}</span>
						<span class="description">{tile.description}</span>
						<span class="badge">Soon</span>
					</div>
				{/if}
			</li>
		{/each}
	</ul>

	<!-- Pushed to the bottom of the screen, just above the pill. -->
	<div class="recent">
		<RecentStrip />
	</div>
</main>

<style>
	main {
		max-width: 40rem;
		margin: 0 auto;
		padding: 1.25rem 1rem 0;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		/* The layout adds 6rem below for the pill. */
		min-height: calc(100dvh - 6rem - env(safe-area-inset-bottom));
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	h1 {
		margin: 0;
	}

	.signout {
		font: inherit;
		font-size: 0.875rem;
		padding: 0.4rem 0.75rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--muted);
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 0.75rem;
	}

	.tile {
		position: relative;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		gap: 0.25rem;
		min-height: 6.5rem;
		padding: 1rem;
		border-radius: 1rem;
		border: 1px solid var(--border);
		background: var(--surface);
		color: inherit;
		text-decoration: none;
	}

	.soon {
		opacity: 0.6;
		/* Keeps the title clear of the badge when the description wraps. */
		padding-top: 2.25rem;
	}

	.name {
		font-size: 1.125rem;
		font-weight: 600;
	}

	.description {
		font-size: 0.875rem;
		color: var(--muted);
	}

	.badge {
		position: absolute;
		top: 0.75rem;
		right: 0.75rem;
		font-size: 0.75rem;
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		color: var(--muted);
	}

	.recent {
		margin-top: auto;
	}
</style>
