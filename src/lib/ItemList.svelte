<script lang="ts">
	import type { Item } from './items.ts';

	let { items }: { items: Item[] } = $props();

	function money(item: Item): string {
		if (item.amount === null) return '';
		return item.currency ? `${item.amount} ${item.currency}` : String(item.amount);
	}
</script>

<ul>
	{#each items as item, index (index)}
		<li>
			<span class="type {item.type}">{item.type}</span>
			<div class="body">
				<span class="title">{item.title}</span>
				{#if item.details}
					<span class="details">{item.details}</span>
				{/if}
				<span class="meta">
					{[money(item), item.date, ...item.tags.map((tag) => `#${tag}`)]
						.filter(Boolean)
						.join(' · ')}
				</span>
			</div>
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
		display: grid;
		gap: 0.1rem;
		min-width: 0;
	}

	.title {
		font-weight: 600;
	}

	.details,
	.meta {
		font-size: 0.875rem;
		color: var(--muted);
	}

	.meta:empty {
		display: none;
	}
</style>
