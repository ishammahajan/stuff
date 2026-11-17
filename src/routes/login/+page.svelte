<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();

	let visible = $state(false);
</script>

<svelte:head>
	<title>Sign in</title>
</svelte:head>

<main>
	<h1>Sign in</h1>
	<form method="POST" use:enhance>
		<label for="password">Password</label>
		<div class="field">
			<!-- svelte-ignore a11y_autofocus -->
			<input
				id="password"
				name="password"
				type={visible ? 'text' : 'password'}
				autocomplete="current-password"
				autocapitalize="off"
				autocorrect="off"
				spellcheck="false"
				required
				autofocus
			/>
			<button
				type="button"
				class="toggle"
				aria-pressed={visible}
				onclick={() => (visible = !visible)}
			>
				{visible ? 'Hide' : 'Show'}
			</button>
		</div>
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

	.field {
		position: relative;
		display: grid;
	}

	.field input {
		padding-right: 4.5rem;
	}

	button.toggle {
		position: absolute;
		top: 50%;
		right: 0.375rem;
		transform: translateY(-50%);
		padding: 0.375rem 0.625rem;
		font-size: 0.875rem;
		font-weight: 400;
		border-color: transparent;
		background: transparent;
		color: var(--accent);
	}

	button[type='submit'] {
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
