<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import { attached } from '#lib/attached.svelte.ts';
	import { formatMoney, localDate, ownShare, type MoneyView } from '#lib/items.ts';
	import { recent } from '#lib/recent.svelte.ts';
	import { Selection } from '#lib/selection.svelte.ts';
	import SelectionBar from '#lib/SelectionBar.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let currency = $derived(data.budget.currency);
	const money = (amount: number) => formatMoney(amount, currency);

	/** The month shown, as YYYY-MM. Each month starts fresh. */
	let month = $state(localDate().slice(0, 7));
	let thisMonth = localDate().slice(0, 7);

	function shiftMonth(by: number) {
		const [y, m] = month.split('-').map(Number);
		const date = new Date(Date.UTC(y, m - 1 + by, 1));
		month = date.toISOString().slice(0, 7);
	}

	let monthName = $derived(
		new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
	);

	/** The day a record counts on: its own date, or the day it was made. */
	const dayOf = (record: MoneyView) => record.date ?? localDate(new Date(record.createdAt));

	/** Whether an amount is in the budget's currency, so it can be added up. */
	const counted = (record: MoneyView) =>
		record.amount !== null && (record.currency === null || record.currency === currency);

	// The month's records, newest first.
	let records = $derived(
		data.money
			.filter((record) => dayOf(record).startsWith(month))
			.sort((a, b) => dayOf(b).localeCompare(dayOf(a)) || b.createdAt.localeCompare(a.createdAt))
	);

	let categoryNames = $derived(new Map(data.budget.categories.map((c) => [c.id, c.name])));

	// Each category with what was spent in it this month, then what fits none.
	let rows = $derived.by(() => {
		const spent = new Map<string | null, number>();
		for (const record of records) {
			if (record.type !== 'expense' || !counted(record)) continue;
			const key = record.category && categoryNames.has(record.category) ? record.category : null;
			// Only the user's own share of a shared expense counts.
			spent.set(key, (spent.get(key) ?? 0) + ownShare(record));
		}
		const list = data.budget.categories.map((category) => ({
			id: category.id as string | null,
			name: category.name,
			monthly: category.monthly as number | null,
			spent: spent.get(category.id) ?? 0
		}));
		const other = spent.get(null);
		if (other) list.push({ id: null, name: 'Uncategorised', monthly: null, spent: other });
		return list;
	});

	let totals = $derived({
		budgeted: data.budget.categories.reduce((sum, c) => sum + c.monthly, 0),
		spent: rows.reduce((sum, row) => sum + row.spent, 0),
		received: records
			.filter((record) => record.type === 'income' && counted(record))
			.reduce((sum, record) => sum + record.amount!, 0)
	});

	// Editing the budget: a copy of the categories as form rows.
	let editing = $state(false);
	let draft = $state<{ id: string; name: string; monthly: string }[]>([]);
	let incomeDraft = $state('');
	let saving = $state(false);
	let formError = $state('');

	function startEditing() {
		draft = data.budget.categories.map((c) => ({ id: c.id, name: c.name, monthly: String(c.monthly) }));
		if (draft.length === 0) draft.push({ id: '', name: '', monthly: '' });
		incomeDraft = data.budget.monthlyIncome === null ? '' : String(data.budget.monthlyIncome);
		formError = '';
		editing = true;
	}

	let draftTotal = $derived(
		draft.reduce((sum, row) => sum + (Number(row.monthly.replace(/[,\s]/g, '')) || 0), 0)
	);

	// The list of records: selection, deleting, and undo.
	const selection = new Selection(() => records.map(({ id, title }) => ({ id, title })));
	let message = $state('');
	let toast = $state<{ text: string; operationId: string } | null>(null);

	const isShared = (record: MoneyView) => record.type === 'expense' && record.shares.length > 0;

	/** An amount in the record's own currency. */
	const recordMoney = (record: MoneyView, amount: number) =>
		record.currency && record.currency !== currency ? `${amount} ${record.currency}` : money(amount);

	/** The amount shown on a record: the user's own share of a shared expense. */
	function amountText(record: MoneyView): string {
		if (record.amount === null) return '';
		const text = recordMoney(record, isShared(record) ? ownShare(record) : record.amount);
		return record.type === 'income' ? `+${text}` : text;
	}

	// Expenses from any month with shares not yet paid back, oldest first.
	let owed = $derived(
		data.money
			.filter((record) => record.type === 'expense' && record.shares.some((share) => !share.settled))
			.sort((a, b) => dayOf(a).localeCompare(dayOf(b)))
	);
	let owedTotal = $derived(
		owed
			.filter(counted)
			.flatMap((record) => record.shares.filter((share) => !share.settled))
			.reduce((sum, share) => sum + share.amount, 0)
	);

	async function settle(record: MoneyView, index: number) {
		const share = record.shares[index];
		const reply = await post(`/api/money/${record.id}`, {
			action: 'settle',
			share: index,
			person: share.person,
			localDate: localDate()
		});
		if (reply && typeof reply.operationId === 'string') {
			toast = { text: `Settled: ${share.person}, ${recordMoney(record, share.amount)}`, operationId: reply.operationId };
		}
		await invalidateAll();
	}

	function meta(record: MoneyView): string {
		const day = new Date(`${dayOf(record)}T00:00:00`).toLocaleDateString(undefined, {
			day: 'numeric',
			month: 'short'
		});
		const kind =
			record.type === 'income'
				? 'Income'
				: ((record.category && categoryNames.get(record.category)) ?? 'Uncategorised');
		const foreign = record.amount !== null && !counted(record) ? 'not counted' : '';
		const shared =
			isShared(record) && record.amount !== null
				? `your share of ${recordMoney(record, record.amount)}, with ${record.shares.map((share) => share.person).join(', ')}`
				: '';
		return [day, kind, shared, foreign].filter(Boolean).join(' · ');
	}

	async function post(url: string, body?: unknown): Promise<Record<string, unknown> | null> {
		message = '';
		const response = await fetch(url, {
			method: 'POST',
			headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		}).catch(() => null);
		if (!response) {
			message = 'Could not reach the server. Try again.';
			return null;
		}
		const reply = await response.json().catch(() => ({}));
		if (!response.ok) {
			message = reply?.message ?? `That didn't work (${response.status}).`;
			return null;
		}
		return reply;
	}

	async function remove(record: MoneyView) {
		const reply = await post(`/api/money/${record.id}`, {
			action: 'delete',
			type: record.type,
			localDate: localDate()
		});
		if (reply && typeof reply.operationId === 'string') {
			toast = { text: `Deleted: ${record.title}`, operationId: reply.operationId };
			selection.selected.delete(record.id);
		}
		await invalidateAll();
	}

	async function undo() {
		if (!toast) return;
		const { operationId } = toast;
		toast = null;
		await post(`/api/operations/${operationId}/undo`);
		await invalidateAll();
	}

	$effect(() => selection.prune(records.map((record) => record.id)));

	// Reloads when a capture finishes, since it may have filed an expense.
	let seen: string | null = null;
	$effect(() => {
		const key = recent.captures
			.filter((capture) => capture.status !== 'pending')
			.map((capture) => capture.id)
			.join(',');
		if (seen !== null && key !== seen) invalidateAll();
		seen = key;
	});

	onMount(() => {
		attached.screen = 'expense';
		recent.refresh();
		return () => {
			attached.screen = null;
			attached.hovering = false;
		};
	});
</script>

<svelte:head>
	<title>Budget</title>
</svelte:head>

<main>
	<header>
		<a href="/">‹ Stuff</a>
	</header>

	<div class="heading">
		<h1>Budget</h1>
		{#if !editing}
			<button class="pill-button" onclick={startEditing}>Edit budget</button>
		{/if}
	</div>

	{#if editing}
		<form
			method="POST"
			action="?/save"
			class="editor"
			use:enhance={() => {
				saving = true;
				formError = '';
				return async ({ result, update }) => {
					saving = false;
					if (result.type === 'success') {
						editing = false;
						await update();
					} else if (result.type === 'failure') {
						formError = String(result.data?.message ?? 'That did not save.');
					} else {
						await update();
					}
				};
			}}
		>
			<p class="muted">Monthly amount for each category. Each month starts fresh.</p>
			<ul class="draft">
				{#each draft as row, i (i)}
					<li>
						<input type="hidden" name="id" value={row.id} />
						<input
							name="name"
							placeholder="Category"
							aria-label="Category name"
							maxlength="40"
							bind:value={row.name}
						/>
						<input
							name="monthly"
							inputmode="decimal"
							placeholder="0"
							aria-label={`Monthly amount for ${row.name || 'this category'}`}
							bind:value={row.monthly}
						/>
						<button
							type="button"
							class="delete"
							aria-label={`Remove ${row.name || 'this category'}`}
							onclick={() => draft.splice(i, 1)}>×</button
						>
					</li>
				{/each}
			</ul>
			<button
				type="button"
				class="pill-button"
				onclick={() => draft.push({ id: '', name: '', monthly: '' })}>Add category</button
			>
			<label class="income">
				<span>Fixed monthly income (optional)</span>
				<input name="monthlyIncome" inputmode="decimal" placeholder="None" bind:value={incomeDraft} />
			</label>
			<p class="muted">Total budgeted: {money(draftTotal)}</p>
			{#if formError}
				<p class="error" role="alert">{formError}</p>
			{/if}
			<div class="buttons">
				<button type="submit" class="primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
				<button type="button" class="pill-button" onclick={() => (editing = false)}>Cancel</button>
			</div>
		</form>
	{:else}
		<nav class="month" aria-label="Month">
			<button onclick={() => shiftMonth(-1)} aria-label="Previous month">‹</button>
			<span>{monthName}</span>
			<button onclick={() => shiftMonth(1)} aria-label="Next month" disabled={month >= thisMonth}
				>›</button
			>
		</nav>

		<section class="summary">
			<div>
				<span class="label">Spent</span>
				<span class="value">{money(totals.spent)}</span>
			</div>
			<div>
				<span class="label">Budget</span>
				<span class="value">{money(totals.budgeted)}</span>
			</div>
			<div>
				<span class="label">Left</span>
				<span class="value" class:over={totals.budgeted - totals.spent < 0}>
					{money(totals.budgeted - totals.spent)}
				</span>
			</div>
			{#if data.budget.monthlyIncome !== null || totals.received > 0}
				<p class="income-line">
					{#if data.budget.monthlyIncome !== null}
						Income {money(data.budget.monthlyIncome)} a month · unbudgeted {money(
							data.budget.monthlyIncome - totals.budgeted
						)}
					{/if}
					{#if totals.received > 0}
						{data.budget.monthlyIncome !== null ? ' · ' : ''}received {money(totals.received)}
					{/if}
				</p>
			{/if}
		</section>

		{#if rows.length === 0}
			<p class="muted">
				No categories yet. Press Edit budget to add them, then say something like “spent 450 on
				lunch”.
			</p>
		{:else}
			<ul class="categories">
				{#each rows as row (row.id ?? 'none')}
					{@const left = row.monthly === null ? null : row.monthly - row.spent}
					<li>
						<div class="line">
							<span class="name">{row.name}</span>
							<span class="figures">
								{money(row.spent)}{row.monthly !== null ? ` of ${money(row.monthly)}` : ''}
							</span>
						</div>
						{#if row.monthly !== null}
							<div class="bar" aria-hidden="true">
								<span
									class:over={left! < 0}
									style:width={`${row.monthly > 0 ? Math.min(100, (row.spent / row.monthly) * 100) : row.spent > 0 ? 100 : 0}%`}
								></span>
							</div>
							<span class="left" class:over={left! < 0}>
								{left! < 0 ? `${money(-left!)} over` : `${money(left!)} left`}
							</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if owed.length > 0}
			<h2>Owed to you{owedTotal > 0 ? ` · ${money(owedTotal)}` : ''}</h2>
			<ul class="owed">
				{#each owed as record (record.id)}
					<li>
						<span class="top">
							<span class="title">{record.title}</span>
							<span class="meta">{meta(record).split(' · ')[0]}</span>
						</span>
						<ul class="shares">
							{#each record.shares as share, i (i)}
								{#if !share.settled}
									<li>
										<span class="person">{share.person}</span>
										<span class="amount">{recordMoney(record, share.amount)}</span>
										<button class="settle" onclick={() => settle(record, i)}>Settle</button>
									</li>
								{/if}
							{/each}
						</ul>
					</li>
				{/each}
			</ul>
		{/if}

		<h2>Records</h2>

		<SelectionBar {selection} noun={['record', 'records']} />

		{#if message}
			<p class="error" role="alert">{message}</p>
		{/if}

		{#if toast}
			<p class="toast" role="status">
				<span>{toast.text}</span>
				<button onclick={undo}>Undo</button>
			</p>
		{/if}

		{#if records.length === 0}
			<p class="muted">Nothing recorded in {monthName}.</p>
		{:else}
			<ul class="records">
				{#each records as record (record.id)}
					<li
						class:selected={selection.selected.has(record.id)}
						{...selection.handlers(record.id, '.edit, .delete')}
					>
						<button
							class="body"
							aria-pressed={selection.selected.has(record.id)}
							onclick={() => selection.toggle(record.id)}
						>
							<span class="top">
								<span class="title">{record.title}</span>
								<span class="amount" class:income={record.type === 'income'}>{amountText(record)}</span>
							</span>
							<span class="meta">{meta(record)}</span>
						</button>
						<button
							class="edit"
							aria-label={`Edit ${record.title} by voice`}
							title="Edit by voice"
							onclick={() => attached.drop([{ id: record.id, title: record.title }])}
						>
							<svg viewBox="0 0 24 24" aria-hidden="true">
								<path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" />
							</svg>
						</button>
						<button class="delete" aria-label={`Delete ${record.title}`} onclick={() => remove(record)}
							>×</button
						>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</main>

<style>
	main {
		max-width: 40rem;
		margin: 0 auto;
		padding: 1.25rem 1rem 2rem;
	}

	header {
		margin-bottom: 1rem;
	}

	a {
		color: var(--accent);
		text-decoration: none;
	}

	button,
	input {
		font: inherit;
		color: inherit;
	}

	button {
		background: transparent;
		border: 0;
	}

	.heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 1rem;
	}

	.heading h1 {
		margin: 0;
	}

	.pill-button {
		padding: 0.3rem 0.8rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		font-size: 0.875rem;
	}

	.primary {
		padding: 0.4rem 1.1rem;
		border-radius: 999px;
		background: var(--accent);
		color: var(--on-accent);
		font-weight: 600;
	}

	.primary:disabled {
		opacity: 0.6;
	}

	.month {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		margin-bottom: 0.75rem;
		font-weight: 600;
	}

	.month button {
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 50%;
		font-size: 1.25rem;
		color: var(--accent);
	}

	.month button:disabled {
		color: var(--muted);
		opacity: 0.4;
	}

	.summary {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.5rem;
		padding: 0.75rem;
		border-radius: 0.875rem;
		border: 1px solid var(--border);
		background: var(--surface);
		margin-bottom: 1rem;
	}

	.summary div {
		display: grid;
		gap: 0.1rem;
		text-align: center;
		min-width: 0;
	}

	.label {
		font-size: 0.8125rem;
		color: var(--muted);
	}

	.value {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		overflow-wrap: anywhere;
	}

	.income-line {
		grid-column: 1 / -1;
		margin: 0.25rem 0 0;
		text-align: center;
		font-size: 0.8125rem;
		color: var(--muted);
	}

	.over {
		color: var(--danger);
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}

	.categories li {
		display: grid;
		gap: 0.3rem;
		padding: 0.6rem 0.75rem;
		border-radius: 0.875rem;
		border: 1px solid var(--border);
		background: var(--surface);
	}

	.line,
	.top {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.5rem;
	}

	.name,
	.title {
		font-weight: 600;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.figures,
	.amount {
		flex: none;
		font-variant-numeric: tabular-nums;
	}

	.figures {
		font-size: 0.875rem;
		color: var(--muted);
	}

	.amount.income {
		color: light-dark(#1b7f3b, #7fd69a);
	}

	.bar {
		height: 0.375rem;
		border-radius: 999px;
		background: var(--border);
		overflow: hidden;
	}

	.bar span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--accent);
	}

	.bar span.over {
		background: var(--danger);
	}

	.left {
		font-size: 0.8125rem;
		color: var(--muted);
	}

	.left.over {
		color: var(--danger);
	}

	h2 {
		font-size: 0.8125rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted);
		margin: 1.5rem 0 0.5rem;
	}

	.records li {
		display: flex;
		align-items: flex-start;
		gap: 0.25rem;
		padding: 0.5rem 0.5rem 0.5rem 0.75rem;
		border-radius: 0.875rem;
		border: 1px solid var(--border);
		background: var(--surface);
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
	}

	/* A selected record is dragged, not scrolled, so the drag works on touch screens. */
	.records li.selected {
		border-color: var(--accent);
		box-shadow: 0 0 0 1px var(--accent);
		touch-action: none;
	}

	.body {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 0.1rem;
		padding: 0.35rem 0.25rem;
		text-align: left;
	}

	.meta {
		font-size: 0.875rem;
		color: var(--muted);
	}

	.edit,
	.delete {
		flex: none;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 50%;
		color: var(--muted);
		font-size: 1.25rem;
		line-height: 1;
	}

	.edit {
		display: grid;
		place-items: center;
	}

	.edit svg {
		width: 1.125rem;
		height: 1.125rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.editor {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.75rem;
		justify-items: start;
	}

	.editor > * {
		margin: 0;
	}

	.draft {
		width: 100%;
	}

	.draft li {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.editor input {
		min-width: 0;
		padding: 0.5rem 0.65rem;
		border-radius: 0.625rem;
		border: 1px solid var(--border);
		background: var(--surface);
	}

	/* A zero base width lets the inputs share the row instead of keeping their own width. */
	.draft input[name='name'] {
		flex: 2 1 0;
		width: 0;
	}

	.draft input[name='monthly'] {
		flex: 1 1 0;
		width: 0;
		text-align: right;
	}

	.income {
		display: grid;
		gap: 0.3rem;
		font-size: 0.875rem;
		color: var(--muted);
	}

	.income input {
		color: var(--text);
	}

	.buttons {
		display: flex;
		gap: 0.5rem;
	}

	.owed > li {
		display: grid;
		gap: 0.35rem;
		padding: 0.6rem 0.75rem;
		border-radius: 0.875rem;
		border: 1px solid var(--border);
		background: var(--surface);
	}

	.shares {
		gap: 0.25rem;
	}

	.shares li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9375rem;
	}

	.person {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.settle {
		flex: none;
		padding: 0.2rem 0.7rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		font-size: 0.8125rem;
		color: var(--accent);
	}

	.toast {
		position: sticky;
		top: 0.5rem;
		z-index: 5;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin: 0 0 0.75rem;
		padding: 0.5rem 0.75rem;
		border-radius: 0.875rem;
		border: 1px solid var(--border);
		background: var(--surface);
		font-size: 0.875rem;
	}

	.toast span {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.toast button {
		padding: 0.25rem 0.7rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		font-size: 0.8125rem;
	}

	p {
		margin: 0 0 0.75rem;
	}

	.muted {
		color: var(--muted);
	}

	.error {
		color: var(--danger);
	}
</style>
