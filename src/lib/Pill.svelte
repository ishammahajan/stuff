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
	// The server takes files up to this size.
	const MAX_FILE_BYTES = 10 * 1024 * 1024;
	const FILE_TYPES = 'image/*,application/pdf';

	type Phase = 'idle' | 'starting' | 'recording';

	interface Session {
		stream: MediaStream;
		recorder: MediaRecorder;
		context: AudioContext;
		analyser: AnalyserNode;
		startedAt: number;
		discarded: boolean;
		/** The capture whose question this recording answers. */
		replyTo: string | null;
		/** The file sent along with this recording. */
		file: File | null;
	}

	let phase = $state<Phase>('idle');
	let seconds = $state(0);
	let uploads = $state(0);
	let message = $state('');
	/** A file waiting to be sent, alone or with the next recording. */
	let attachment = $state<File | null>(null);
	let canvas: HTMLCanvasElement;
	let picker: HTMLInputElement;

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
			discarded: false,
			replyTo: recent.replyTo?.id ?? null,
			file: attachment
		};
		recorder.ondataavailable = (event) => {
			if (event.data.size > 0) chunks.push(event.data);
		};
		recorder.onstop = () => {
			if (!current.discarded) {
				upload(new Blob(chunks, { type: recorder.mimeType }), current.file, current.replyTo);
			}
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

	/** Sends a recording, a file, or both. The file and the reply stay set if it fails. */
	async function upload(recording: Blob | null, file: File | null, replyTo: string | null) {
		uploads += 1;
		try {
			const form = new FormData();
			if (recording) form.set('audio', await toWav(recording), 'capture.wav');
			if (file) form.set('file', file, file.name);
			form.set('localDate', localDate());
			form.set('timeZone', Intl.DateTimeFormat().resolvedOptions().timeZone);
			if (replyTo) form.set('replyTo', replyTo);
			const response = await fetch('/api/capture', { method: 'POST', body: form });
			if (response.ok) {
				if (replyTo && recent.replyTo?.id === replyTo) recent.replyTo = null;
				if (file && attachment === file) attachment = null;
				recent.refresh();
			} else {
				const body = await response.json().catch(() => null);
				message = body?.message ?? `Upload failed (${response.status}).`;
			}
		} catch {
			message = 'Could not send. Check your connection and try again.';
		} finally {
			uploads -= 1;
		}
	}

	function attach(file: File | undefined) {
		if (!file) return;
		message = '';
		if (!file.type.startsWith('image/') && file.type !== 'application/pdf') {
			message = 'Only images and PDFs can be sent.';
		} else if (file.size > MAX_FILE_BYTES) {
			message = 'The file is larger than 10 MB.';
		} else {
			attachment = file;
		}
	}

	function onpicked() {
		attach(picker.files?.[0]);
		// Lets the same file be picked again later.
		picker.value = '';
	}

	function onpaste(event: ClipboardEvent) {
		const file = event.clipboardData?.files[0];
		if (!file || isTyping(event.target)) return;
		event.preventDefault();
		attach(file);
	}

	const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;

	function ondragover(event: DragEvent) {
		if (carriesFiles(event)) event.preventDefault();
	}

	function ondrop(event: DragEvent) {
		if (!carriesFiles(event)) return;
		event.preventDefault();
		attach(event.dataTransfer?.files[0]);
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

<svelte:window {onkeydown} {onkeyup} {onpaste} {ondragover} {ondrop} />

<div class="dock">
	{#if message}
		<p class="message" role="alert">{message}</p>
	{:else if uploads > 0}
		<p class="hint">Sending…</p>
	{/if}
	{#if attachment}
		<p class="chip">
			<span>{attachment.name}</span>
			{#if phase === 'idle'}
				<button class="send" onclick={() => upload(null, attachment, recent.replyTo?.id ?? null)}
					>Send</button
				>
			{/if}
			<button aria-label="Remove file" onclick={() => (attachment = null)}>×</button>
		</p>
	{/if}
	{#if recent.replyTo}
		<p class="chip">
			<span>Replying: {recent.replyTo.question}</span>
			<button aria-label="Stop replying" onclick={() => (recent.replyTo = null)}>×</button>
		</p>
	{/if}
	<div class="row">
		{#if phase === 'idle'}
			<button class="side attach" aria-label="Attach an image or a PDF" onclick={() => picker.click()}
				>+</button
			>
		{/if}
		<input bind:this={picker} type="file" accept={FILE_TYPES} hidden onchange={onpicked} />
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
			<button class="side discard" aria-label="Discard recording" onclick={() => finish(false)}
				>×</button
			>
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

	.side {
		position: absolute;
		top: 50%;
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

	.discard {
		left: 100%;
		transform: translate(0.5rem, -50%);
	}

	.attach {
		right: 100%;
		transform: translate(-0.5rem, -50%);
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

	.chip {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		max-width: 18rem;
		margin: 0;
		padding: 0.2rem 0.3rem 0.2rem 0.75rem;
		border-radius: 999px;
		border: 1px solid var(--accent);
		background: var(--surface);
		color: var(--accent);
		font-size: 0.8125rem;
	}

	.chip span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chip button.send {
		width: auto;
		padding: 0 0.6rem;
		border: 1px solid var(--accent);
		border-radius: 999px;
		font-size: 0.8125rem;
	}

	.chip button {
		flex: none;
		width: 1.5rem;
		height: 1.5rem;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 1rem;
		line-height: 1;
	}

	.message {
		color: var(--danger);
	}
</style>
