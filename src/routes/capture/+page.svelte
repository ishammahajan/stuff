<script lang="ts">
	import { onDestroy } from 'svelte';
	import { toWav } from '#lib/audio.ts';
	import ItemList from '#lib/ItemList.svelte';
	import type { CaptureView } from '#lib/items.ts';

	const MAX_SECONDS = 180;

	type Phase = 'idle' | 'recording' | 'processing' | 'done' | 'error';

	let phase = $state<Phase>('idle');
	let seconds = $state(0);
	let capture = $state<CaptureView | null>(null);
	let message = $state('');

	let recorder: MediaRecorder | undefined;
	let stream: MediaStream | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	function localDate(): string {
		const now = new Date();
		const pad = (value: number) => String(value).padStart(2, '0');
		return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	}

	function releaseMicrophone() {
		clearInterval(timer);
		stream?.getTracks().forEach((track) => track.stop());
		stream = undefined;
	}

	function fail(text: string) {
		releaseMicrophone();
		message = text;
		phase = 'error';
	}

	async function start() {
		capture = null;
		message = '';
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch {
			fail('Microphone access was blocked. Allow it for this site and try again.');
			return;
		}

		const chunks: Blob[] = [];
		recorder = new MediaRecorder(stream);
		recorder.ondataavailable = (event) => {
			if (event.data.size > 0) chunks.push(event.data);
		};
		recorder.onstop = () => upload(new Blob(chunks, { type: recorder?.mimeType }));
		recorder.start();

		seconds = 0;
		phase = 'recording';
		timer = setInterval(() => {
			seconds += 1;
			if (seconds >= MAX_SECONDS) stop();
		}, 1000);
	}

	function stop() {
		if (recorder?.state === 'recording') recorder.stop();
		releaseMicrophone();
		phase = 'processing';
	}

	async function upload(recording: Blob) {
		try {
			const form = new FormData();
			form.set('audio', await toWav(recording), 'capture.wav');
			form.set('localDate', localDate());
			form.set('timeZone', Intl.DateTimeFormat().resolvedOptions().timeZone);

			const response = await fetch('/api/capture', { method: 'POST', body: form });
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				fail(body?.message ?? body?.error ?? `Upload failed (${response.status}).`);
				return;
			}

			capture = await response.json();
			phase = 'done';
		} catch {
			fail('Could not send the recording. Check your connection and try again.');
		}
	}

	onDestroy(() => {
		if (recorder?.state === 'recording') {
			recorder.onstop = null;
			recorder.stop();
		}
		releaseMicrophone();
	});
</script>

<svelte:head>
	<title>Capture</title>
</svelte:head>

<main>
	<header>
		<a href="/">‹ Stuff</a>
		<a href="/inbox">Inbox</a>
	</header>

	<div class="recorder">
		{#if phase === 'recording'}
			<button class="record recording" onclick={stop} aria-label="Stop recording">
				<span class="square"></span>
			</button>
			<p class="status">
				{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')} · tap to stop
			</p>
		{:else if phase === 'processing'}
			<button class="record" disabled aria-label="Working">
				<span class="dot"></span>
			</button>
			<p class="status">Working on it…</p>
		{:else}
			<button class="record" onclick={start} aria-label="Start recording">
				<span class="dot"></span>
			</button>
			<p class="status">Tap and speak</p>
		{/if}
	</div>

	{#if phase === 'error'}
		<p class="error" role="alert">{message}</p>
	{/if}

	{#if phase === 'done' && capture}
		<section>
			{#if capture.status === 'failed'}
				<p class="error" role="alert">
					The recording is saved, but it couldn't be read. Retry it from the inbox.
				</p>
				<p class="quote">{capture.error}</p>
			{:else}
				{#if capture.items.length > 0}
					<ItemList items={capture.items} />
				{:else}
					<p class="status">Nothing to file from that recording.</p>
				{/if}
				{#if capture.transcript}
					<p class="quote">“{capture.transcript}”</p>
				{/if}
			{/if}
		</section>
	{/if}
</main>

<style>
	main {
		max-width: 40rem;
		margin: 0 auto;
		padding: 1.25rem 1rem 2rem;
	}

	header {
		display: flex;
		justify-content: space-between;
	}

	a {
		color: var(--accent);
		text-decoration: none;
	}

	.recorder {
		display: grid;
		justify-items: center;
		gap: 1rem;
		margin: 3rem 0 2rem;
	}

	.record {
		width: 8rem;
		height: 8rem;
		border-radius: 50%;
		border: 2px solid var(--border);
		background: var(--surface);
		display: grid;
		place-items: center;
	}

	.record:disabled {
		opacity: 0.5;
	}

	.dot,
	.square {
		display: block;
		background: var(--danger);
	}

	.dot {
		width: 3.5rem;
		height: 3.5rem;
		border-radius: 50%;
	}

	.square {
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 0.5rem;
	}

	.recording {
		border-color: var(--danger);
	}

	.status {
		margin: 0;
		color: var(--muted);
	}

	section {
		display: grid;
		gap: 1rem;
		padding: 1rem;
		border-radius: 1rem;
		border: 1px solid var(--border);
		background: var(--surface);
	}

	.quote {
		margin: 0;
		font-size: 0.875rem;
		color: var(--muted);
		overflow-wrap: anywhere;
	}

	.error {
		margin: 0;
		color: var(--danger);
	}
</style>
