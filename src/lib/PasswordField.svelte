<script lang="ts">
	import type { FullAutoFill } from 'svelte/elements';

	interface Props {
		id: string;
		name: string;
		label: string;
		autocomplete: FullAutoFill;
		autofocus?: boolean;
	}

	let { id, name, label, autocomplete, autofocus = false }: Props = $props();

	let visible = $state(false);
</script>

<label for={id}>{label}</label>
<div class="field">
	<!-- svelte-ignore a11y_autofocus -->
	<input
		{id}
		{name}
		type={visible ? 'text' : 'password'}
		{autocomplete}
		autocapitalize="off"
		autocorrect="off"
		spellcheck="false"
		required
		{autofocus}
	/>
	<button type="button" class="toggle" aria-pressed={visible} onclick={() => (visible = !visible)}>
		{visible ? 'Hide' : 'Show'}
	</button>
</div>

<style>
	.field {
		position: relative;
		display: grid;
	}

	input {
		font: inherit;
		padding: 0.75rem 4.5rem 0.75rem 0.75rem;
		border-radius: 0.75rem;
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--text);
	}

	.toggle {
		position: absolute;
		top: 50%;
		right: 0.375rem;
		transform: translateY(-50%);
		font: inherit;
		font-size: 0.875rem;
		padding: 0.375rem 0.625rem;
		border: none;
		background: transparent;
		color: var(--accent);
	}
</style>
