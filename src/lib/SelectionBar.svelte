<script lang="ts">
	// The bar over a utility screen while records are selected, and the label that
	// follows the pointer while they are dragged.
	import type { Selection } from './selection.svelte.ts';

	/** `noun` names one record and several, for example ['task', 'tasks']. */
	let { selection, noun }: { selection: Selection; noun: [string, string] } = $props();

	let count = $derived(selection.selected.size);
</script>

{#if count > 0}
	<div class="selection">
		<span>{count} selected. Drag onto the pill, or</span>
		<button class="primary" onclick={() => selection.talkAbout()}
			>Talk about {count === 1 ? 'it' : 'them'}</button
		>
		<button onclick={() => selection.selected.clear()}>Clear</button>
	</div>
{/if}

{#if selection.drag}
	<div class="ghost" style:left="{selection.drag.x}px" style:top="{selection.drag.y}px">
		{count} {count === 1 ? noun[0] : noun[1]}
	</div>
{/if}

<style>
	.selection {
		position: sticky;
		top: 0.5rem;
		z-index: 5;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0 0.75rem;
		padding: 0.5rem 0.75rem;
		border-radius: 0.875rem;
		border: 1px solid var(--accent);
		background: var(--surface);
		font-size: 0.875rem;
	}

	button {
		font: inherit;
		color: inherit;
		background: transparent;
		padding: 0.25rem 0.7rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		font-size: 0.8125rem;
	}

	button.primary {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--on-accent);
	}

	.ghost {
		position: fixed;
		z-index: 20;
		transform: translate(-50%, -150%);
		padding: 0.3rem 0.75rem;
		border-radius: 999px;
		background: var(--accent);
		color: var(--on-accent);
		font-size: 0.875rem;
		font-weight: 600;
		pointer-events: none;
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.2);
	}
</style>
