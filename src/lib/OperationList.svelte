<script lang="ts">
	import { enhance } from '$app/forms';
	import { describeRepeat, type Item, type OperationKind, type OperationView } from './items.ts';

	interface Props {
		operations: OperationView[];
		/** Undoes an operation from the client. Without it, Undo posts the inbox's `undo` action. */
		onundo?: (id: string) => void;
	}

	let { operations, onundo }: Props = $props();

	const VERBS: Record<OperationKind, string> = {
		create: 'Added',
		update: 'Changed',
		complete: 'Done',
		reopen: 'Reopened',
		delete: 'Deleted'
	};

	function money(item: Item): string {
		if (item.amount === null) return '';
		return item.currency ? `${item.amount} ${item.currency}` : String(item.amount);
	}

	function meta(operation: OperationView): string {
		const { item, previous } = operation;
		const renamed = previous && previous.title !== item.title ? `was “${previous.title}”` : '';
		return [
			renamed,
			item.important ? 'Important' : '',
			money(item),
			item.date,
			item.repeat ? describeRepeat(item.repeat) : '',
			item.remindAt ? `Reminder ${item.remindAt.replace('T', ' ')}` : '',
			...item.tags.map((tag) => `#${tag}`)
		]
			.filter(Boolean)
			.join(' · ');
	}
</script>

<ul>
	{#each operations as operation (operation.id)}
		{@const item = operation.item}
		<li class:undone={operation.undone}>
			<span class="type {item.type}">{item.type}</span>
			<div class="body">
				<span class="title">
					<span class="verb">{VERBS[operation.kind]}:</span>
					{item.title}
				</span>
				{#if item.details}
					<span class="details">{item.details}</span>
				{/if}
				<span class="meta">{meta(operation)}</span>
			</div>
			{#if operation.undone}
				<span class="state">Undone</span>
			{:else if onundo}
				<button type="button" onclick={() => onundo(operation.id)}>Undo</button>
			{:else}
				<form method="POST" action="?/undo" use:enhance>
					<input type="hidden" name="id" value={operation.id} />
					<button type="submit">Undo</button>
				</form>
			{/if}
		</li>
	{/each}
</ul>

<style>
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}

	li {
		display: flex;
		gap: 0.75rem;
		align-items: flex-start;
	}

	li.undone .body {
		opacity: 0.5;
		text-decoration: line-through;
	}

	.type {
		flex: none;
		width: 4.5rem;
		text-align: center;
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.15rem 0;
		border-radius: 999px;
		border: 1px solid var(--border);
		color: var(--muted);
	}

	.type.expense {
		color: var(--danger);
	}

	.type.income,
	.type.task {
		color: var(--accent);
	}

	.body {
		flex: 1;
		display: grid;
		gap: 0.1rem;
		min-width: 0;
	}

	.title {
		font-weight: 600;
	}

	.verb {
		font-weight: 400;
		color: var(--muted);
	}

	.details,
	.meta,
	.state {
		font-size: 0.875rem;
		color: var(--muted);
	}

	.meta:empty {
		display: none;
	}

	button {
		font: inherit;
		font-size: 0.8125rem;
		padding: 0.15rem 0.6rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--muted);
	}
</style>
