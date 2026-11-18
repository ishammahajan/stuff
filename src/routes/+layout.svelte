<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import favicon from '#lib/assets/favicon.svg';
	import Pill from '#lib/Pill.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// Pages a signed-out visitor sees have no pill.
	const SIGNED_OUT = ['/login', '/join/', '/recover'];
	let signedIn = $derived(!SIGNED_OUT.some((path) => page.url.pathname.startsWith(path)));
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<link rel="manifest" href="/manifest.webmanifest" />
	<meta name="theme-color" content="#111214" media="(prefers-color-scheme: dark)" />
	<meta name="theme-color" content="#f6f6f4" media="(prefers-color-scheme: light)" />
</svelte:head>

{#if signedIn}
	<!-- Room at the bottom, so the pill never covers the end of a page. -->
	<div class="with-pill">
		{@render children()}
	</div>
	<Pill />
{:else}
	{@render children()}
{/if}

<style>
	.with-pill {
		padding-bottom: calc(6rem + env(safe-area-inset-bottom));
	}
</style>
