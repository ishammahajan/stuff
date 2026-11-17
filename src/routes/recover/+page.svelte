<script lang="ts">
	import { enhance } from '$app/forms';
	import PasswordField from '#lib/PasswordField.svelte';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<svelte:head>
	<title>Recover account</title>
</svelte:head>

<main>
	<h1>Recover account</h1>
	<p class="muted">
		Enter the recovery code you saved when you joined, and choose a new password. This signs you
		out on your other devices.
	</p>
	<form method="POST" use:enhance>
		<label for="code">Recovery code</label>
		<!-- svelte-ignore a11y_autofocus -->
		<input
			id="code"
			name="code"
			autocomplete="off"
			autocapitalize="characters"
			autocorrect="off"
			spellcheck="false"
			placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
			required
			autofocus
		/>
		<PasswordField id="password" name="password" label="New password" autocomplete="new-password" />
		<PasswordField
			id="confirmation"
			name="confirmation"
			label="New password again"
			autocomplete="new-password"
		/>
		{#if form?.message}
			<p class="error" role="alert">{form.message}</p>
		{/if}
		<button type="submit">Set new password</button>
	</form>
	<p class="aside"><a href="/login">Back to sign in</a></p>
</main>

<style>
	main {
		max-width: 22rem;
		margin: 12vh auto 0;
		padding: 0 1rem;
	}

	p {
		margin: 0 0 1rem;
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

	input {
		font-family: ui-monospace, monospace;
	}

	button {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--on-accent);
		font-weight: 600;
	}

	.muted {
		color: var(--muted);
		font-size: 0.875rem;
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
