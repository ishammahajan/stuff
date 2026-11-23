<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let input = $state('');

	type Theme = 'system' | 'light' | 'dark';
	const THEMES: { value: Theme; label: string }[] = [
		{ value: 'system', label: 'System' },
		{ value: 'light', label: 'Light' },
		{ value: 'dark', label: 'Dark' }
	];

	// Read in the browser; `app.html` applies the stored choice before the first paint.
	let theme = $state<Theme>('system');
	$effect.pre(() => {
		const current = document.documentElement.dataset.theme;
		theme = current === 'light' || current === 'dark' ? current : 'system';
	});

	function setTheme(value: Theme) {
		theme = value;
		const root = document.documentElement;
		try {
			if (value === 'system') localStorage.removeItem('theme');
			else localStorage.setItem('theme', value);
		} catch {
			// Storage is blocked; the choice still applies until the page reloads.
		}
		if (value === 'system') delete root.dataset.theme;
		else root.dataset.theme = value;
	}
</script>

<svelte:head>
	<title>Settings</title>
</svelte:head>

<main>
	<header>
		<a href="/">‹ Stuff</a>
	</header>

	<h1>Settings</h1>

	<section>
		<h2>Appearance</h2>
		<div class="segments" role="radiogroup" aria-label="Theme">
			{#each THEMES as option (option.value)}
				<button
					role="radio"
					aria-checked={theme === option.value}
					class:active={theme === option.value}
					onclick={() => setTheme(option.value)}>{option.label}</button
				>
			{/each}
		</div>
		<p class="muted">Saved on this device only.</p>
	</section>

	<section>
		<h2>Names</h2>
		<p class="muted">
			Names you say often, such as people, places, and companies, spelled the way you want
			them written. Recordings then catch them instead of a word that sounds alike.
		</p>

		<form
			class="add"
			method="POST"
			action="?/addNames"
			use:enhance={() =>
				async ({ result, update }) => {
					await update({ reset: false });
					if (result.type === 'success') input = '';
				}}
		>
			<input
				name="names"
				bind:value={input}
				placeholder="Add a name, or several with commas"
				aria-label="Names to add"
				autocomplete="off"
				autocapitalize="words"
			/>
			<button class="primary" type="submit">Add</button>
		</form>
		{#if form?.message}
			<p class="error" role="alert">{form.message}</p>
		{/if}

		{#if data.names.length > 0}
			<ul>
				{#each data.names as name (name)}
					<li>
						<span>{name}</span>
						<form method="POST" action="?/removeName" use:enhance>
							<input type="hidden" name="name" value={name} />
							<button type="submit" aria-label={`Remove ${name}`}>×</button>
						</form>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted">No names yet.</p>
		{/if}
	</section>
</main>

<style>
	main {
		max-width: 40rem;
		margin: 0 auto;
		padding: 1.25rem 1rem 2rem;
		display: grid;
		gap: 1rem;
	}

	header a {
		color: var(--accent);
		text-decoration: none;
	}

	h1,
	h2,
	p {
		margin: 0;
	}

	h2 {
		font-size: 1.125rem;
	}

	section {
		display: grid;
		gap: 0.75rem;
	}

	.muted {
		color: var(--muted);
		font-size: 0.9375rem;
	}

	.error {
		color: var(--danger);
		font-size: 0.875rem;
	}

	.add {
		display: flex;
		gap: 0.5rem;
	}

	input {
		flex: 1;
		min-width: 0;
		font: inherit;
		padding: 0.55rem 0.9rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--text);
	}

	button {
		font: inherit;
		color: inherit;
		background: transparent;
		border: 0;
	}

	.segments {
		display: flex;
		justify-self: start;
		padding: 0.2rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--surface);
	}

	.segments button {
		padding: 0.4rem 1rem;
		border-radius: 999px;
		color: var(--muted);
	}

	.segments button.active {
		background: var(--accent);
		color: var(--on-accent);
	}

	.primary {
		padding: 0.5rem 1.1rem;
		border-radius: 999px;
		background: var(--accent);
		color: var(--on-accent);
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	li {
		display: flex;
		align-items: center;
		gap: 0.15rem;
		padding: 0.2rem 0.25rem 0.2rem 0.85rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--surface);
		max-width: 100%;
	}

	li span {
		overflow-wrap: anywhere;
	}

	li button {
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 50%;
		color: var(--muted);
		font-size: 1.125rem;
		line-height: 1;
	}
</style>
