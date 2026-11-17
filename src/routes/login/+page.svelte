<script lang="ts">
	import { enhance } from '$app/forms';
	import PasswordField from '#lib/PasswordField.svelte';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<svelte:head>
	<title>Sign in</title>
</svelte:head>

<main>
	<h1>Sign in</h1>
	<form method="POST" use:enhance>
		<PasswordField
			id="password"
			name="password"
			label="Password"
			autocomplete="current-password"
			autofocus
		/>
		{#if form?.message}
			<p class="error" role="alert">{form.message}</p>
		{/if}
		<button type="submit">Sign in</button>
	</form>
	<p class="aside"><a href="/recover">Forgot your password?</a></p>
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

	button {
		font: inherit;
		padding: 0.75rem;
		border-radius: 0.75rem;
		border: 1px solid var(--accent);
		background: var(--accent);
		color: var(--on-accent);
		font-weight: 600;
	}

	.error {
		margin: 0;
		color: var(--danger);
	}

	.aside {
		margin-top: 1.25rem;
		font-size: 0.875rem;
	}

	a {
		color: var(--accent);
	}
</style>
