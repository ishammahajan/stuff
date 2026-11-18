# Stuff

A personal app of small utilities (tasks, knowledge, budget), opened from the iPhone
action button. Speech is the main input: the user records a voice memo, and a model
turns it into items for the utilities. An image or a PDF can be sent too, alone or
with a recording. Human setup steps are in `README.md`.

Keep this file current. When a change alters anything described here, update this file
in the same commit.

## Stack

SvelteKit **3** with Svelte 5 runes, `@sveltejs/adapter-node`, Postgres through Drizzle
ORM and postgres.js, and Node 24 or later, which runs `.ts` scripts directly.
SvelteKit 3 differs from version 2 in ways that are easy to get wrong:

- Environment variables are declared in `src/env.ts` with `defineEnvVars` and imported
  from `$app/env/private`. There is no `$env/static/private`.
- Hook types (`Handle`, `ServerInit`) come from `@sveltejs/kit/hooks`.
- There is no `svelte.config.js`. The SvelteKit config lives in `vite.config.ts`.
- The service worker is `src/service-worker/index.ts`, with its own `tsconfig.json`.
  The main `tsconfig.json` excludes that folder.
- Import app code with the `#lib/...` alias (declared under `imports` in
  `package.json`) and keep the `.ts` extension, for example `#lib/server/auth.ts`.

Run `pnpm check` (types for the app and the service worker) and `pnpm build` before
committing.

## Map

### Accounts, sessions, and encryption

Each user's data is private to them and encrypted at rest. The rules:

- **Every query on user data filters by `locals.account.id`.** There is no admin
  view, and no code path reads another user's rows.
- **Every piece of user content is encrypted** with the account's data key
  (`locals.account.key`) through `encrypt`/`encryptJson` in
  `src/lib/server/crypto.ts`. The context string is `<table>:<row id>:<column>`, so
  IDs are generated in the app (`randomUUID()`) before the insert. Only metadata
  stays plaintext: IDs, user IDs, timestamps, types, and status.
- **The server holds a key only while handling that user's request** or a job the
  request started. Nothing can decrypt a user's data while they are away, so work
  that needs the key and was interrupted resumes on the user's next request (see
  `GET /api/capture/{id}` and the inbox load).

The parts:

- `src/lib/server/crypto.ts`: AES-256-GCM, scrypt for passwords and recovery codes,
  HKDF for session tokens, and recovery code generation. It has no SvelteKit
  imports, so scripts can use it.
- `src/lib/server/auth.ts`:
  - A random data key per user is stored wrapped by the password-derived key
    (`users.password_key`) and by the recovery-code-derived key
    (`users.recovery_key`).
  - Login is by password alone: `signIn` tries the password against every user's
    wrapped key, which is fine for a handful of accounts. So two accounts can't
    share a password, and `checkPasswordFree` enforces that at sign-up and
    recovery. A clash counts as a failed attempt.
  - Failed attempts are throttled globally (in memory, reset on restart).
  - Each session row stores the data key wrapped by a key derived from the cookie
    token. The database keeps only the token's SHA-256.
- `src/hooks.server.ts`: sets `locals.account` (`{ id, key }`) from the session
  cookie. Everything except `/login`, `/join/*`, and `/recover` requires it: pages
  redirect to `/login`, and `/api/*` returns 401 JSON.
- Sign-up is by invite only. `pnpm invite` (`scripts/invite.ts`) prints a one-time
  link to `/join/<token>` that is valid for 7 days. The invitee chooses their own
  password, and then sees their recovery code once.
- `/recover` takes a recovery code and a new password, re-wraps the key, and signs
  the account out everywhere else.
- `src/lib/PasswordField.svelte` is the password input with a Show/Hide toggle.
- CSRF protection is SvelteKit's origin check, so production needs `ORIGIN` set.

### Capture pipeline

1. The pill (`src/lib/Pill.svelte`, see **Capture interface**) records with
   `MediaRecorder`. `src/lib/audio.ts` converts the recording to 16 kHz mono 16-bit
   WAV. An attached file is sent as it is.
2. `POST /api/capture` (`src/routes/api/capture/+server.ts`) takes a recording, a
   file, or both. It validates them, stores them encrypted in `captures.audio` and
   `captures.file`, starts processing, and returns `202 {id}`. A file's type comes
   from its first bytes (`attachmentType`): PNG, JPEG, WebP, HEIC, or PDF, up to
   10 MB. The local date, time zone, file name and type, transcript, and error live
   in the encrypted `captures.body` JSON.
3. `src/lib/server/captures.ts` processes in the background with the account's key.
   It keeps an in-process set of captures in progress, so one capture never gets
   two model calls. After a restart, a pending capture resumes when its owner polls
   it or opens the inbox.
   **Speech detection:** first, `keepSpeech` (`src/lib/server/speech.ts`) runs
   Silero VAD (`models/silero_vad.onnx`, through `onnxruntime-node`) over the
   recording. It recognizes speech rather than loudness, so fan, traffic, or café
   noise doesn't count. It cuts pauses longer than 1 s and the noise around the
   speech. A recording with no speech is dropped, and without a file the capture is
   done with nothing filed and no model call. Background speech, such as a TV,
   still passes; the prompt handles it. The model takes about 50 MB of memory and
   0.7 s of CPU per minute of audio. If detection fails, the whole recording is
   sent.
4. Before the call, all of the user's records are loaded and decrypted
   (`loadRecords` in `src/lib/server/records.ts`). `snapshot` puts a capped list in
   the prompt: up to 50 open tasks, and the latest 20 notes, 20 expenses, and 10
   income records. The prompt says the list is partial.
5. `src/lib/server/openrouter.ts` (`interpretMemo`) sends the audio, the file (an
   image as `image_url`, a PDF as `file`), and instructions to
   `google/gemini-3.8-flash` on OpenRouter with two tools, in a loop of at most four
   calls. `search_records` runs `searchRecords`, a keyword match over the decrypted
   records. `file_memo` ends the loop with the transcript and a list of operations:
   create, update, complete, or delete by record ID. The last call forces
   `file_memo`. The instructions tell the model to file only speech meant for the
   app and to ignore background speech, such as a TV. A file is filed by what it
   holds, such as a receipt as an expense; a file with many entries, such as a bank
   statement, becomes one summary note. `file_memo` can also carry
   one question (see **Questions** below).
6. On success, one transaction marks the capture `done` (or `asking`, when it has
   an open question), deletes the audio and the file, and applies the operations
   (`applyOperations`). Operations on an ID the account
   doesn't own, and a second operation on the same record, are skipped. On failure
   the capture becomes `failed`, and the audio is kept for a retry.
7. The dashboard's recent strip (`src/lib/RecentStrip.svelte`) shows the last 24
   hours of the latest three captures from `GET /api/captures`, through the shared
   state in `src/lib/recent.svelte.ts`. It polls every 2 s while one is pending,
   and the pill refreshes it after each upload. A capture that filed nothing shows
   as "Nothing was recognized", or "Nothing to file" with its transcript or file
   name. Undo goes
   through `POST /api/operations/{id}/undo`. `GET /api/capture/{id}` still reports
   a single capture.
8. `src/routes/inbox` lists captures with what each one did
   (`src/lib/OperationList.svelte`), with Undo on each operation, and retry and
   delete actions on each capture. Captures that filed nothing are hidden. Both
   lists put open questions first.

**Questions:** the model asks only when a wrong guess would change or remove the
wrong record, such as completing one of two matching tasks. It still files the
clear parts, and never asks about new records or missing details. The question and
two to four options, each with the exact operations to apply, live in the
encrypted `captures.body`. `src/lib/Question.svelte` shows it in the strip and the
inbox:

- Tapping an option (`POST /api/captures/{id}/answer` with `{ option }`) applies
  that option's operations, checked again by `applyOperations`, under the asking
  capture. `{ option: null }` dismisses the question.
- "Answer by voice" sets `recent.replyTo`, which shows a "Replying" chip on the
  pill. The next recording is posted with `replyTo`, and the model receives the
  earlier transcript, the question, and the options. A reply can't ask again, and
  filing it closes the question as "Answered by voice". A reply to a question that
  was closed meanwhile is filed as a plain memo.

Item types and the shared shapes live in `src/lib/items.ts`.

**Undo:** every applied operation is logged in `operations` with the record's
encrypted state before and after. `undoOperation` writes the before state back.
Only the latest change to a record can be undone, so an undo never overwrites a
later change. Deleting a capture deletes its log, not its records.

### Capture interface

- **The pill** (`src/lib/Pill.svelte`) sits at the bottom centre of every signed-in
  screen. It lives in `src/routes/+layout.svelte`, so a recording continues across
  navigation, and the layout pads pages so the pill never covers their end. It shows
  a flat line when idle and the live waveform (an `AnalyserNode`) while recording.
- **Tap** starts, and a second tap stops and sends. **Holding** longer than 300 ms
  records like a walkie-talkie and sends on release. **Space** does the same on a
  desktop, except while typing in a field. Silence never stops a recording.
- **Discard:** the × next to the pill, or swiping the pill down 60 px.
- **Limit:** recordings stop and send at 3 minutes.
- **Files:** the + left of the pill opens the file picker (on iPhone: Photos,
  Camera, or Files). On a desktop, pasting a file (outside a text field) or
  dropping one anywhere on the page also attaches it. The file shows as a chip
  above the pill with **Send** and ×. Send sends it alone; recording instead sends
  it with the recording as a voice note. The chip clears once the upload succeeds.
  Spreadsheets (XLSX, XLS) aren't accepted yet: they come with statement import in
  Budget. The iPhone Share sheet can't send here, because only an installed web
  app can be a share target.
- **No auto-record:** opening the app never starts a recording.
- **Tabs on iPhone:** a page can't close a Safari tab it didn't open, and Shortcuts
  can't open a Home Screen web app, so the app runs in Safari. The action-button
  Shortcut opens the plain site URL, and Safari reuses the open tab when the same
  URL is opened again. Don't make the dashboard rewrite its own URL (for example
  with query parameters), or the next press opens a new tab.

### Offline and startup speed

`src/service-worker/index.ts` keeps one cache per deployment (`stuff-${version}`):

- Built and static files are cache-first.
- The dashboard (`/`) is stale-while-revalidate, so it opens at once. The first open
  after a deploy can show the previous version.
- A cached dashboard is dropped when the session ends.

Because the dashboard HTML can be stale, it must not render server data that needs
to be fresh. Fetch that data from the client instead, as the recent strip does.

### Data

- `src/lib/server/db/schema.ts` defines the tables: `users`, `invites`, `sessions`,
  `captures`, `records`, and `operations`. Each encrypted column notes its context
  string.
- `records` is shared by all utilities. Each row has a user, a type, timestamps,
  `completed_at` for tasks, and an encrypted body (`ItemFields`). Totals and
  searches run in memory after decryption. A utility may get its own table when
  the shared table doesn't fit, for example for large files.
- To change the schema, edit `schema.ts`, run `pnpm db:generate`, and commit the SQL
  in `drizzle/`. `pnpm start` applies migrations (`scripts/migrate.ts`) before the
  server starts, locally and on Railway.

## Adding a utility (current pattern)

1. Add its route under `src/routes/<name>/` and give its dashboard tile an `href`
   in `src/routes/+page.svelte`.
2. Store its items as `records` with a new type: add the type to `ITEM_TYPES` in
   `src/lib/items.ts`, a snapshot limit in `SNAPSHOT_LIMITS` in
   `src/lib/server/records.ts`, and its description to the instructions in
   `src/lib/server/openrouter.ts`. If it needs fields that `ItemFields` lacks, add
   them there, to the `file_memo` schema, and to `cleanFields`.
3. Only if the shared table doesn't fit, add a table to `schema.ts` and generate a
   migration. Every table of user data gets a `user_id`, and every content column
   is encrypted, as described under **Accounts, sessions, and encryption**.
4. Update this file.

## Decided, not built yet

Remove each point from this section as it lands, and describe the result in **Map**.

- **Richer records:** a record can be any small document, such as a budget
  category with its allocation, a transaction that references a category by ID, or
  a statement import. Budget may add a static map (its categories) to the snapshot.
- **Search with embeddings:** embeddings arrive with the Knowledge utility, for
  queries such as "give me my startup ideas". The input is audio, so there is no
  text to embed before the call: retrieval happens only through the search tool.
- **Model provider:** stay on OpenRouter. Calling Google directly, so that only
  Google receives the audio, was considered and rejected on 2026-11-18.
- **Order:** the Tasks, Knowledge, and Budget utilities. Read
  `~/dev/projects/budgeting` before building Budget.

### Capture interface, remaining parts

- **Drag to edit:** on a utility screen, dragging one or more selected items onto
  the pill attaches them as chips and starts a tap-style recording. The model
  receives them as the items being talked about. Recording on a utility's screen
  also leans the model toward that utility. Build this with the first utility
  screen.
- **Home screen:** later, today's tasks and the month's spending join the tiles,
  and the recent strip also shows answers to questions.
- **Not wanted for now:** per-user spending caps. The OpenRouter key has a daily
  cap. Build limits only when a real problem appears.

## Deployment

- Railway project `stuff`, service `web` (plus `Postgres`), at
  https://web-production-56f07443.up.railway.app. There is no custom domain.
- Deploy from this folder with `railway up --service web --detach`. The service is
  not connected to GitHub.
- The Railway CLI remembers the linked project by folder path. After the folder
  moves, run
  `railway link --project ccfe2f39-cd6b-4928-9337-785d58e155cb --environment production --service web`
  before `railway up`. Otherwise `railway up` creates a new project.
- Variables on `web`: `DATABASE_URL` (a reference to Postgres), `ORIGIN`,
  `OPENROUTER_API_KEY`, and `BODY_SIZE_LIMIT=20M` (a recording and a file in one
  request).
- To invite someone, run the script inside the `web` container, where the private
  database URL and `ORIGIN` are set:
  `railway ssh --service web -- node scripts/invite.ts`. This needs an SSH key on
  the Railway account (`railway ssh keys github` imports GitHub's). The Postgres
  service has no public URL, on purpose.
- Don't add `railway.json` or `railway.toml`. Railway stops reading them on
  2026-12-01. Railpack detects the `build` and `start` scripts on its own.

## Local development

- Database: `docker compose up -d` (Postgres 18 on `127.0.0.1:5433`). If Docker
  can't create its network (this machine's kernel has had that problem), run a
  throwaway database on the host network instead:
  `docker run -d --rm --name stuff-db-temp --network host -e POSTGRES_USER=stuff -e POSTGRES_PASSWORD=stuff -e POSTGRES_DB=stuff postgres:18-alpine -p 5433 -c listen_addresses=127.0.0.1`
- `.env` holds `DATABASE_URL` and `OPENROUTER_API_KEY`. It is git-ignored. Never
  print or commit its values.
- Create a local account with `pnpm invite --origin http://localhost:3000` and open
  the link.
- To test the production build, run `pnpm build`, then
  `env ORIGIN=http://localhost:3000 PORT=3000 BODY_SIZE_LIMIT=20M node --env-file=.env build`
  (also in `.claude/launch.json`).
- To test capture without a microphone, post a WAV file to `/api/capture` with a
  session cookie, the `Origin` header, and `localDate` and `timeZone` form fields.
  In a browser, replace `navigator.mediaDevices.getUserMedia` with an
  oscillator-backed stream.
