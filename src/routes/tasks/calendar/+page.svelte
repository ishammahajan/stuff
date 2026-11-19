<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let copied = $state(false);

	async function copy(link: string) {
		try {
			await navigator.clipboard.writeText(link);
			copied = true;
		} catch {
			copied = false;
		}
	}

	const hour = $derived(
		new Date(2000, 0, 1, data.dueHour).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
	);
</script>

<svelte:head>
	<title>Calendar alarms</title>
</svelte:head>

<main>
	<header>
		<a href="/tasks">‹ Tasks</a>
	</header>

	<h1>Calendar alarms</h1>

	<p>
		Your phone's Calendar can ring for your tasks. A task with a reminder time rings then. Any
		other task with a date rings at {hour} on that date. Completed tasks don't ring.
	</p>

	{#if form?.link}
		<section class="card">
			<h2>Your link</h2>
			<p>
				This link is shown only once. Anyone who has it can read the titles and times of your
				reminders, but nothing else in Stuff.
			</p>
			<a class="primary" href={form.webcal}>Subscribe on this phone</a>
			<button onclick={() => copy(form.link)}>{copied ? 'Copied' : 'Copy link'}</button>
			<ol>
				<li>Tap <strong>Subscribe on this phone</strong>, then <strong>Subscribe</strong>.</li>
				<li>
					On the next screen, turn <strong>Remove Alerts</strong> off. Otherwise the calendar shows
					your tasks but never rings.
				</li>
				<li>Tap <strong>Done</strong>.</li>
			</ol>
			<p class="muted">
				Calendar fetches the link on its own schedule, so a reminder you add can take a while to
				arrive. To fetch more often, set Calendar's <strong>Fetch New Data</strong> setting in the
				iPhone Settings app.
			</p>
		</section>
	{:else if data.connected}
		<section class="card">
			<h2>Connected</h2>
			<p>
				A calendar link is active. If you lost it, or think someone else has it, make a new one. The
				old link stops working.
			</p>
			<form method="POST" action="?/create" use:enhance>
				<button class="primary" type="submit">Make a new link</button>
			</form>
		</section>
	{:else}
		<form method="POST" action="?/create" use:enhance>
			<button class="primary" type="submit">Make a calendar link</button>
		</form>
	{/if}

	{#if data.connected || form?.link}
		<form method="POST" action="?/delete" use:enhance>
			<button type="submit">Turn off calendar alarms</button>
		</form>
		<p class="muted">Turning off stops the link. Also delete the calendar from your phone.</p>
	{/if}
</main>

<style>
	main {
		max-width: 40rem;
		margin: 0 auto;
		padding: 1.25rem 1rem 2rem;
		display: grid;
		gap: 0.75rem;
		justify-items: start;
	}

	header a {
		color: var(--accent);
		text-decoration: none;
	}

	h1,
	h2,
	p,
	ol {
		margin: 0;
	}

	h2 {
		font-size: 1.125rem;
	}

	.card {
		display: grid;
		gap: 0.75rem;
		justify-items: start;
		padding: 1rem;
		border-radius: 1rem;
		border: 1px solid var(--border);
		background: var(--surface);
		width: 100%;
	}

	ol {
		padding-left: 1.25rem;
		display: grid;
		gap: 0.4rem;
	}

	button,
	.primary {
		font: inherit;
		font-size: 0.9375rem;
		padding: 0.5rem 1rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text);
		text-decoration: none;
	}

	.primary {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--on-accent);
	}

	.muted {
		color: var(--muted);
		font-size: 0.875rem;
	}
</style>
