<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<svelte:head>
	<title>Sign in</title>
</svelte:head>

<main>
	<h1>Sign in</h1>
	<form method="POST" use:enhance>
		<label for="password">Password</label>
		<!-- svelte-ignore a11y_autofocus -->
		<input
			id="password"
			name="password"
			type="password"
			autocomplete="current-password"
			required
			autofocus
		/>
		{#if form?.message}
			<p class="error" role="alert">{form.message}</p>
		{/if}
		<button type="submit">Sign in</button>
	</form>
</main>

<style>
	main {
		max-width: 20rem;
		margin: 20vh auto 0;
		padding: 0 1rem;
	}

	form {
		display: grid;
		gap: 0.75rem;
	}

	input,
	button {
		font: inherit;
		padding: 0.75rem;
		border-radius: 0.75rem;
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--text);
	}

	button {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
		font-weight: 600;
	}

	.error {
		margin: 0;
		color: var(--danger);
	}
</style>
