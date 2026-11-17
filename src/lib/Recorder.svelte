<script lang="ts">
	import { onDestroy } from 'svelte';
	import { toWav } from '#lib/audio.ts';

	interface Props {
		/** Called with the new capture's ID once the server has saved the recording. */
		onsent: (id: string) => void;
	}

	let { onsent }: Props = $props();

	const MAX_SECONDS = 180;

	type Phase = 'idle' | 'recording' | 'sending' | 'sent' | 'error';

	let phase = $state<Phase>('idle');
	let seconds = $state(0);
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
		phase = 'sending';
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

			const { id } = await response.json();
			phase = 'sent';
			onsent(id);
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

<div class="recorder">
	{#if phase === 'recording'}
		<button class="record recording" onclick={stop} aria-label="Stop recording">
			<span class="square"></span>
		</button>
		<p class="status">
			{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')} · tap to stop
		</p>
	{:else if phase === 'sending'}
		<button class="record" disabled aria-label="Sending">
			<span class="dot"></span>
		</button>
		<p class="status">Sending…</p>
	{:else}
		<button class="record" onclick={start} aria-label="Start recording">
			<span class="dot"></span>
		</button>
		{#if phase === 'sent'}
			<p class="status">Sent. You'll see a note here when it's filed.</p>
		{:else if phase === 'error'}
			<p class="error" role="alert">{message}</p>
		{:else}
			<p class="status">Tap and speak</p>
		{/if}
	{/if}
</div>

<style>
	.recorder {
		display: grid;
		justify-items: center;
		gap: 0.75rem;
		margin: 1.5rem 0;
		text-align: center;
	}

	.record {
		width: 7rem;
		height: 7rem;
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
		width: 3rem;
		height: 3rem;
		border-radius: 50%;
	}

	.square {
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.5rem;
	}

	.recording {
		border-color: var(--danger);
	}

	.status,
	.error {
		margin: 0;
	}

	.status {
		color: var(--muted);
	}

	.error {
		color: var(--danger);
	}
</style>
