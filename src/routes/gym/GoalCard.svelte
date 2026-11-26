<script lang="ts">
	import { formatSet, measureOf, type GoalView } from '#lib/items.ts';

	interface Props {
		goal: GoalView;
		/** Reached in the last day, so it is celebrated. */
		fresh: boolean;
		ondelete: () => void;
	}

	let { goal, fresh, ondelete }: Props = $props();

	// The bar runs from where the speaker was when the goal was set to the target.
	let fraction = $derived.by(() => {
		if (goal.completedAt) return 1;
		if (goal.current === null) return 0;
		const from = goal.start ?? 0;
		const span = goal.target - from;
		return span <= 0 ? 1 : Math.min(1, Math.max(0, (goal.current - from) / span));
	});

	const day = (iso: string) => {
		const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
		return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
	};
</script>

<li class="goal" class:fresh class:reached={!!goal.completedAt}>
	<div class="body">
		<span class="title">
			{#if fresh}<span class="badge">Reached</span>{/if}
			{goal.title}
		</span>
		<span class="meta">
			{goal.goal.exercise}: {formatSet(goal.goal.target, measureOf(goal.goal.target))}
			{#if goal.completedAt}
				· reached {day(goal.completedAt)}
			{:else if goal.date}
				· by {day(goal.date)}
			{/if}
		</span>
		{#if !goal.completedAt}
			<div
				class="bar"
				role="meter"
				aria-label={`Progress toward ${goal.title}`}
				aria-valuemin={goal.start ?? 0}
				aria-valuemax={goal.target}
				aria-valuenow={goal.current ?? 0}
			>
				<span style:width={`${fraction * 100}%`}></span>
			</div>
			<span class="meta">
				{#if goal.current === null}
					Not done yet.
				{:else}
					Best {goal.current} of {goal.target} {goal.unit}{#if goal.start !== null}, from {goal.start}{/if}.
				{/if}
				{#if goal.weeksLeft !== null}
					About {goal.weeksLeft} {goal.weeksLeft === 1 ? 'week' : 'weeks'} at the recent pace.
				{/if}
			</span>
		{/if}
	</div>
	<button class="delete" aria-label={`Delete goal: ${goal.title}`} onclick={ondelete}>×</button>
</li>

<style>
	.goal {
		display: flex;
		align-items: flex-start;
		gap: 0.25rem;
		padding: 0.5rem 0.5rem 0.5rem 0.75rem;
		border-radius: 0.875rem;
		border: 1px solid var(--border);
		background: var(--surface);
	}

	.fresh {
		border-color: var(--accent);
	}

	.body {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 0.25rem;
		padding: 0.35rem 0;
		overflow-wrap: anywhere;
	}

	.title {
		font-weight: 600;
	}

	.reached:not(.fresh) .title {
		color: var(--muted);
	}

	.badge {
		display: inline-block;
		margin-right: 0.25rem;
		padding: 0.05rem 0.5rem;
		border-radius: 999px;
		background: var(--accent);
		color: var(--on-accent);
		font-size: 0.75rem;
		vertical-align: 0.1em;
	}

	.meta {
		font-size: 0.875rem;
		color: var(--muted);
	}

	.bar {
		height: 0.5rem;
		border-radius: 999px;
		background: var(--border);
		overflow: hidden;
	}

	.bar span {
		display: block;
		height: 100%;
		border-radius: 999px;
		background: var(--accent);
	}

	button {
		flex: none;
		width: 2.25rem;
		height: 2.25rem;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: var(--muted);
		font: inherit;
		font-size: 1.25rem;
		line-height: 1;
	}
</style>
