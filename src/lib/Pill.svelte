<script lang="ts">
	import { onDestroy } from 'svelte';
	import { toWav } from '#lib/audio.ts';
	import { recent } from '#lib/recent.svelte.ts';

	// Recordings stop and send at this length.
	const MAX_SECONDS = 180;
	// A press longer than this records like a walkie-talkie and sends on release.
	const HOLD_MS = 300;
	// Dragging the pill down this far while recording throws the recording away.
	const SWIPE_PX = 60;

	type Phase = 'idle' | 'starting' | 'recording';

	interface Session {
		stream: MediaStream;
		recorder: MediaRecorder;
		context: AudioContext;
		analyser: AnalyserNode;
		startedAt: number;
		discarded: boolean;
	}

	let phase = $state<Phase>('idle');
	let seconds = $state(0);
	let uploads = $state(0);
	let message = $state('');
	let canvas: HTMLCanvasElement;

	let session: Session | null = null;
	let cancelStart = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let frame = 0;

	// The press in progress, from the pointer or the space bar.
	let press: { startedRecording: boolean; y: number | null } | null = null;

	function localDate(): string {
		const now = new Date();
		const pad = (value: number) => String(value).padStart(2, '0');
		return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	}

	async function start() {
		phase = 'starting';
		message = '';
		cancelStart = false;
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch {
			phase = 'idle';
			message = 'Microphone access was blocked. Allow it for this site and try again.';
			return;
		}
		if (cancelStart) {
			stream.getTracks().forEach((track) => track.stop());
			phase = 'idle';
			return;
		}

		const context = new AudioContext();
		context.resume().catch(() => {});
		const analyser = context.createAnalyser();
		analyser.fftSize = 1024;
		context.createMediaStreamSource(stream).connect(analyser);

		const chunks: Blob[] = [];
		const recorder = new MediaRecorder(stream);
		const current: Session = {
			stream,
			recorder,
			context,
			analyser,
			startedAt: performance.now(),
			discarded: false
		};
		recorder.ondataavailable = (event) => {
			if (event.data.size > 0) chunks.push(event.data);
		};
		recorder.onstop = () => {
			if (!current.discarded) upload(new Blob(chunks, { type: recorder.mimeType }));
		};
		recorder.start();
		session = current;

		seconds = 0;
		phase = 'recording';
		timer = setInterval(() => {
			seconds += 1;
			if (seconds >= MAX_SECONDS) finish(true);
		}, 1000);
		frame = requestAnimationFrame(draw);
	}

	/** Ends the recording, and sends it unless `send` is false. */
	function finish(send: boolean) {
		if (phase === 'starting') {
			cancelStart = true;
			return;
		}
		const current = session;
		if (!current) return;
		session = null;
		current.discarded = !send;
		if (current.recorder.state === 'recording') current.recorder.stop();
		current.stream.getTracks().forEach((track) => track.stop());
		current.context.close().catch(() => {});
		clearInterval(timer);
		cancelAnimationFrame(frame);
		phase = 'idle';
	}

	async function upload(recording: Blob) {
		uploads += 1;
		try {
			const form = new FormData();
			form.set('audio', await toWav(recording), 'capture.wav');
			form.set('localDate', localDate());
			form.set('timeZone', Intl.DateTimeFormat().resolvedOptions().timeZone);
			const response = await fetch('/api/capture', { method: 'POST', body: form });
			if (response.ok) {
				recent.refresh();
			} else {
				const body = await response.json().catch(() => null);
				message = body?.message ?? `Upload failed (${response.status}).`;
			}
		} catch {
			message = 'Could not send the recording. Check your connection and try again.';
		} finally {
			uploads -= 1;
		}
	}

	// Press and release, shared by the pointer and the space bar. A press while idle
	// starts recording. Releasing it after HOLD_MS of recording sends (hold);
	// releasing it sooner keeps recording until the next press is released (tap).
	function pressDown(y: number | null) {
		if (press) return;
		press = { startedRecording: phase === 'idle', y };
		if (phase === 'idle') start();
	}

	function pressUp() {
		const current = press;
		press = null;
		if (!current) return;
		if (!current.startedRecording) {
			finish(true);
		} else if (session && performance.now() - session.startedAt > HOLD_MS) {
			finish(true);
		}
	}

	function onpointerdown(event: PointerEvent) {
		if (!event.isPrimary || event.button !== 0) return;
		try {
			// Keeps move and release events coming when the finger leaves the pill.
			(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		} catch {
			// The pointer is already gone; the press still counts.
		}
		pressDown(event.clientY);
	}

	function onpointermove(event: PointerEvent) {
		if (press?.y == null || phase === 'idle') return;
		if (event.clientY - press.y > SWIPE_PX) {
			press = null;
			finish(false);
		}
	}

	function onclick(event: MouseEvent) {
		// Pointer presses are handled above. A click with no pointer behind it comes
		// from the keyboard (Enter on the focused pill) and counts as a tap.
		if (event.detail !== 0) return;
		if (phase === 'idle') start();
		else finish(true);
	}

	function isTyping(target: EventTarget | null): boolean {
		return (
			target instanceof HTMLElement &&
			(target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
		);
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.code !== 'Space' || isTyping(event.target)) return;
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		event.preventDefault();
		if (!event.repeat) pressDown(null);
	}

	function onkeyup(event: KeyboardEvent) {
		if (event.code !== 'Space' || isTyping(event.target)) return;
		// Keeps Space from also clicking a focused button.
		event.preventDefault();
		pressUp();
	}

	function prepareCanvas(): CanvasRenderingContext2D | null {
		const ratio = window.devicePixelRatio || 1;
		const width = canvas.clientWidth * ratio;
		const height = canvas.clientHeight * ratio;
		if (canvas.width !== width) canvas.width = width;
		if (canvas.height !== height) canvas.height = height;
		const context = canvas.getContext('2d');
		if (!context) return null;
		context.clearRect(0, 0, width, height);
		context.lineWidth = 2 * ratio;
		context.lineCap = 'round';
		context.strokeStyle = getComputedStyle(canvas).color;
		return context;
	}

	function drawFlat() {
		const context = prepareCanvas();
		if (!context) return;
		context.beginPath();
		context.moveTo(0, canvas.height / 2);
		context.lineTo(canvas.width, canvas.height / 2);
		context.stroke();
	}

	function draw() {
		if (!session) return;
		const context = prepareCanvas();
		if (context) {
			const samples = new Uint8Array(session.analyser.fftSize);
			session.analyser.getByteTimeDomainData(samples);
			context.beginPath();
			for (let i = 0; i < samples.length; i++) {
				const x = (i / (samples.length - 1)) * canvas.width;
				// Exaggerates quiet speech so the line visibly moves.
				const level = Math.max(-1, Math.min(1, ((samples[i] - 128) / 128) * 3));
				const y = canvas.height / 2 + (level * canvas.height) / 2;
				if (i === 0) context.moveTo(x, y);
				else context.lineTo(x, y);
			}
			context.stroke();
		}
		frame = requestAnimationFrame(draw);
	}

	// Draws the idle line once the pill has its idle colour.
	$effect(() => {
		if (phase === 'idle') drawFlat();
	});

	onDestroy(() => {
		if (session) finish(false);
	});
</script>

<svelte:window {onkeydown} {onkeyup} />

<div class="dock">
	{#if message}
		<p class="message" role="alert">{message}</p>
	{:else if uploads > 0}
		<p class="hint">Sending…</p>
	{/if}
	<div class="row">
		<button
			class="pill"
			class:live={phase !== 'idle'}
			aria-label={phase === 'idle' ? 'Record' : 'Stop and send'}
			title="Tap to record, or hold to talk"
			{onpointerdown}
			onpointerup={pressUp}
			onpointercancel={pressUp}
			{onpointermove}
			{onclick}
			oncontextmenu={(event) => event.preventDefault()}
		>
			<canvas bind:this={canvas}></canvas>
			{#if phase === 'recording'}
				<span class="time">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>
			{/if}
		</button>
		{#if phase !== 'idle'}
			<button class="discard" aria-label="Discard recording" onclick={() => finish(false)}>×</button>
		{/if}
	</div>
</div>

<style>
	.dock {
		position: fixed;
		left: 50%;
		bottom: max(1rem, env(safe-area-inset-bottom));
		transform: translateX(-50%);
		display: grid;
		justify-items: center;
		gap: 0.5rem;
		width: max-content;
		max-width: calc(100vw - 2rem);
		z-index: 10;
	}

	.row {
		position: relative;
	}

	.pill {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 10rem;
		height: 3.25rem;
		padding: 0 1.1rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--muted);
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.15);
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
		cursor: pointer;
	}

	.pill.live {
		border-color: var(--danger);
		color: var(--danger);
	}

	canvas {
		flex: 1;
		min-width: 0;
		height: 1.75rem;
		color: inherit;
	}

	.time {
		font-size: 0.8125rem;
		font-variant-numeric: tabular-nums;
	}

	.discard {
		position: absolute;
		top: 50%;
		left: 100%;
		transform: translate(0.5rem, -50%);
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 50%;
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--muted);
		font: inherit;
		font-size: 1.25rem;
		line-height: 1;
	}

	.message,
	.hint {
		margin: 0;
		padding: 0.35rem 0.75rem;
		border-radius: 999px;
		background: var(--surface);
		border: 1px solid var(--border);
		font-size: 0.8125rem;
		text-align: center;
	}

	.hint {
		color: var(--muted);
	}

	.message {
		color: var(--danger);
	}
</style>
