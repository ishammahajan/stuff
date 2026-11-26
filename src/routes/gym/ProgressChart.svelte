<script lang="ts">
	import type { Measure } from '#lib/items.ts';

	interface Series {
		name: string;
		measure: Measure;
		points: { date: string; value: number }[];
	}

	interface Props {
		/** Each exercise's best score per session, the most recent exercise first. */
		series: Series[];
		/** The exercise shown first, such as one with a goal. */
		initial?: string;
	}

	let { series, initial }: Props = $props();

	// The exercise picked here, or else the initial one.
	let chosen = $state<string | null>(null);
	let current = $derived(
		series.find((s) => s.name === chosen) ?? series.find((s) => s.name === initial) ?? series[0]
	);

	const UNITS: Record<Measure, string> = { weight_reps: 'kg est. max', reps: 'reps', time: 's' };

	let width = $state(320);
	const HEIGHT = 168;
	const PAD = { top: 12, right: 12, bottom: 24, left: 36 };

	const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

	let geometry = $derived.by(() => {
		if (!current) return null;
		const points = current.points;
		const values = points.map((p) => p.value);
		let low = Math.min(...values);
		let high = Math.max(...values);
		// Some room above and below, and a range even for a single value.
		const room = Math.max((high - low) * 0.15, high * 0.05, 1);
		low = Math.max(0, low - room);
		high = high + room;
		const first = dayNumber(points[0].date);
		const last = dayNumber(points[points.length - 1].date);
		const span = Math.max(last - first, 1);
		const plotWidth = width - PAD.left - PAD.right;
		const plotHeight = HEIGHT - PAD.top - PAD.bottom;
		const x = (date: string) =>
			points.length === 1 ? PAD.left + plotWidth / 2 : PAD.left + ((dayNumber(date) - first) / span) * plotWidth;
		const y = (value: number) => PAD.top + (1 - (value - low) / (high - low)) * plotHeight;
		const ticks = [low, (low + high) / 2, high].map((value) => ({ value: Math.round(value), y: y(value) }));
		const marks = points.map((p) => ({ ...p, x: x(p.date), y: y(p.value) }));
		return { marks, ticks, path: marks.map((m, i) => `${i ? 'L' : 'M'}${m.x},${m.y}`).join(' ') };
	});

	let hovered = $state<number | null>(null);

	function hover(event: PointerEvent) {
		if (!geometry) return;
		const box = (event.currentTarget as SVGElement).getBoundingClientRect();
		const at = event.clientX - box.left;
		let best = 0;
		geometry.marks.forEach((mark, i) => {
			if (Math.abs(mark.x - at) < Math.abs(geometry!.marks[best].x - at)) best = i;
		});
		hovered = best;
	}

	const shortDate = (date: string) => {
		const [y, m, d] = date.split('-').map(Number);
		return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
	};
</script>

{#if current && geometry}
	<div class="chart">
		<label class="pick">
			<span class="visually-hidden">Exercise</span>
			<select
				value={current.name}
				onchange={(event) => {
					chosen = event.currentTarget.value;
					hovered = null;
				}}
			>
				{#each series as s (s.name)}
					<option value={s.name}>{s.name}</option>
				{/each}
			</select>
			<span class="unit">best per session, {UNITS[current.measure]}</span>
		</label>

		<div class="plot" bind:clientWidth={width}>
			<svg
				{width}
				height={HEIGHT}
				role="img"
				aria-label={`${current.name}: ${current.points.map((p) => `${p.date} ${p.value}`).join(', ')}`}
				onpointermove={hover}
				onpointerdown={hover}
				onpointerleave={() => (hovered = null)}
			>
				{#each geometry.ticks as tick (tick.y)}
					<line class="grid" x1={PAD.left} x2={width - PAD.right} y1={tick.y} y2={tick.y} />
					<text class="axis" x={PAD.left - 6} y={tick.y} text-anchor="end" dominant-baseline="middle"
						>{tick.value}</text
					>
				{/each}
				<text class="axis" x={PAD.left} y={HEIGHT - 6}>{shortDate(current.points[0].date)}</text>
				{#if current.points.length > 1}
					<text class="axis" x={width - PAD.right} y={HEIGHT - 6} text-anchor="end"
						>{shortDate(current.points[current.points.length - 1].date)}</text
					>
				{/if}
				{#if hovered !== null}
					<line class="cross" x1={geometry.marks[hovered].x} x2={geometry.marks[hovered].x} y1={PAD.top} y2={HEIGHT - PAD.bottom} />
				{/if}
				<path class="line" d={geometry.path} />
				{#each geometry.marks as mark, i (mark.date + i)}
					<circle class="dot" class:active={hovered === i} cx={mark.x} cy={mark.y} r={hovered === i ? 5 : 4} />
				{/each}
			</svg>
			{#if hovered !== null}
				{@const mark = geometry.marks[hovered]}
				<div
					class="tip"
					style:left={`${Math.min(Math.max(mark.x, 60), width - 60)}px`}
					style:top={`${mark.y}px`}
				>
					<strong>{mark.value}</strong> {UNITS[current.measure]}<br />{shortDate(mark.date)}
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.chart {
		padding: 0.5rem 0.75rem 0.25rem;
		border-radius: 0.875rem;
		border: 1px solid var(--border);
		background: var(--surface);
	}

	.pick {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 0.5rem;
	}

	select {
		max-width: 100%;
		padding: 0.3rem 0.5rem;
		border-radius: 0.5rem;
		border: 1px solid var(--border);
		background: var(--bg);
		color: var(--text);
		font: inherit;
		font-weight: 600;
	}

	.unit {
		font-size: 0.8125rem;
		color: var(--muted);
	}

	.plot {
		position: relative;
		margin-top: 0.25rem;
	}

	svg {
		display: block;
		touch-action: pan-y;
	}

	.grid {
		stroke: var(--border);
		stroke-width: 1;
	}

	.axis {
		fill: var(--muted);
		font-size: 11px;
	}

	.cross {
		stroke: var(--muted);
		stroke-width: 1;
		stroke-dasharray: 3 3;
	}

	.line {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2;
		stroke-linejoin: round;
		stroke-linecap: round;
	}

	.dot {
		fill: var(--accent);
		stroke: var(--surface);
		stroke-width: 2;
	}

	.tip {
		position: absolute;
		transform: translate(-50%, calc(-100% - 10px));
		padding: 0.3rem 0.5rem;
		border-radius: 0.5rem;
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--text);
		font-size: 0.8125rem;
		line-height: 1.3;
		white-space: nowrap;
		pointer-events: none;
		box-shadow: 0 2px 8px rgb(0 0 0 / 0.12);
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}
</style>
