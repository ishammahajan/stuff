<script lang="ts">
	import type { QuestionView } from './items.ts';
	import { recent } from './recent.svelte.ts';

	interface Props {
		captureId: string;
		question: QuestionView;
		/** Runs after an answer is sent, for pages that hold their own copy of the captures. */
		onanswered?: () => void;
	}

	let { captureId, question, onanswered }: Props = $props();

	let busy = $state(false);
	let replying = $derived(recent.replyTo?.id === captureId);

	async function answer(option: number | null) {
		busy = true;
		await recent.answer(captureId, option);
		busy = false;
		onanswered?.();
	}

	function reply() {
		recent.replyTo = replying ? null : { id: captureId, question: question.text };
	}
</script>

<div class="question" class:open={!question.answer}>
	<p class="text">{question.text}</p>
	{#if question.answer}
		<p class="answer">{question.answer}</p>
	{:else}
		<div class="options">
			{#each question.options as label, index (index)}
				<button disabled={busy} onclick={() => answer(index)}>{label}</button>
			{/each}
		</div>
		<div class="options">
			<button class="quiet" class:active={replying} disabled={busy} onclick={reply}>
				{replying ? 'Replying with the next recording' : 'Answer by voice'}
			</button>
			<button class="quiet" disabled={busy} onclick={() => answer(null)}>Dismiss</button>
		</div>
	{/if}
</div>

<style>
	.question {
		display: grid;
		gap: 0.5rem;
	}

	p {
		margin: 0;
		overflow-wrap: anywhere;
	}

	.open .text {
		font-weight: 600;
	}

	.answer {
		font-size: 0.875rem;
		color: var(--muted);
	}

	.options {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}

	button {
		font: inherit;
		font-size: 0.875rem;
		padding: 0.35rem 0.75rem;
		border-radius: 999px;
		border: 1px solid var(--accent);
		background: transparent;
		color: var(--accent);
		text-align: left;
	}

	button.quiet {
		border-color: var(--border);
		color: var(--muted);
	}

	button.active {
		border-color: var(--accent);
		color: var(--accent);
	}

	button:disabled {
		opacity: 0.5;
	}
</style>
