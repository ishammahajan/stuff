<script lang="ts">
	import { enhance } from '$app/forms';
	import PasswordField from '#lib/PasswordField.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let copied = $state(false);

	async function copy(code: string) {
		try {
			await navigator.clipboard.writeText(code);
			copied = true;
		} catch {
			// Clipboard access can be refused; the code is still on screen to copy by hand.
		}
	}
</script>

<svelte:head>
	<title>Join Stuff</title>
</svelte:head>

<main>
	{#if form?.recoveryCode}
		<h1>Save your recovery code</h1>
		<p>
			Your data is encrypted with a key that only your password or this code can unlock. If you
			forget your password, this code is the only way back in. Without either, your data can't be
			recovered by anyone.
		</p>
		<p class="code">{form.recoveryCode}</p>
		<button type="button" class="secondary" onclick={() => copy(form.recoveryCode)}>
			{copied ? 'Copied' : 'Copy code'}
		</button>
		<p class="muted">Keep it somewhere safe, such as your password manager. It's shown only once.</p>
		<a class="primary" href="/">I've saved it. Continue</a>
	{:else if !data.valid}
		<h1>Invite expired</h1>
		<p>This invite link has expired or was already used. Ask for a new one.</p>
	{:else}
		<h1>Join Stuff</h1>
		<p class="muted">Choose a password. It signs you in and protects your data.</p>
		<form method="POST" use:enhance>
			<PasswordField
				id="password"
				name="password"
				label="Password"
				autocomplete="new-password"
				autofocus
			/>
			<PasswordField
				id="confirmation"
				name="confirmation"
				label="Password again"
				autocomplete="new-password"
			/>
			{#if form?.message}
				<p class="error" role="alert">{form.message}</p>
			{/if}
			<button type="submit" class="primary">Create account</button>
		</form>
	{/if}
</main>

<style>
	main {
		max-width: 22rem;
		margin: 12vh auto 0;
		padding: 0 1rem;
		display: grid;
		gap: 0.75rem;
	}

	h1,
	p {
		margin: 0;
	}

	form {
		display: grid;
		gap: 0.75rem;
	}

	.code {
		font-family: ui-monospace, monospace;
		font-size: 1.05rem;
		letter-spacing: 0.04em;
		padding: 0.75rem;
		border-radius: 0.75rem;
		border: 1px solid var(--border);
		background: var(--surface);
		overflow-wrap: anywhere;
		user-select: all;
	}

	.primary,
	.secondary {
		font: inherit;
		padding: 0.75rem;
		border-radius: 0.75rem;
		text-align: center;
		text-decoration: none;
	}

	.primary {
		border: 1px solid var(--accent);
		background: var(--accent);
		color: var(--on-accent);
		font-weight: 600;
	}

	.secondary {
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text);
	}

	.muted {
		color: var(--muted);
		font-size: 0.875rem;
	}

	.error {
		color: var(--danger);
	}
</style>
