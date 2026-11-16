<script lang="ts">
	import '../app.css';
	import favicon from '#lib/assets/favicon.svg';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<link rel="manifest" href="/manifest.webmanifest" />
	<meta name="theme-color" content="#111214" media="(prefers-color-scheme: dark)" />
	<meta name="theme-color" content="#f6f6f4" media="(prefers-color-scheme: light)" />
</svelte:head>

{@render children()}
