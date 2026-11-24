<script lang="ts">
	// The model's answer to a question the user asked, with the question when given.
	let { answer, asked = null }: { answer: string; asked?: string | null } = $props();
</script>

<div class="answer">
	{#if asked}
		<p class="asked">“{asked}”</p>
	{/if}
	<p class="text">{answer}</p>
</div>

<style>
	.answer {
		display: grid;
		gap: 0.375rem;
	}

	p {
		margin: 0;
		overflow-wrap: anywhere;
	}

	.asked {
		font-size: 0.875rem;
		color: var(--muted);
	}

	/* The answer is plain text, with one list item per line. */
	.text {
		white-space: pre-line;
	}
</style>
