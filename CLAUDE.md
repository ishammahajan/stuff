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
- **One exception, chosen by the user:** a calendar feed (see **Reminders**) keeps
  a copy of task titles and times that its link's token can decrypt. The token
  unlocks only that copy, never the data key.

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
  cookie. Everything except `/login`, `/join/*`, `/recover`, and `/calendar/*`
  requires it: pages redirect to `/login`, and `/api/*` returns 401 JSON.
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
   file, or both, plus optional `items` (IDs of records dragged onto the pill) and
   `screen` (the record type of the utility screen it was recorded on). It
   validates them, stores them encrypted in `captures.audio` and
   `captures.file`, starts processing, and returns `202 {id}`. A file's type comes
   from its first bytes (`attachmentType`): PNG, JPEG, WebP, HEIC, or PDF, up to
   10 MB. The local date, time zone, file name and type, selected items, screen,
   transcript, and error live in the encrypted `captures.body` JSON.
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
   income records. The prompt says the list is partial. Records the user selected
   (`describeRecords`) are listed separately as what "this" or "these" means, and
   the screen leans the model toward that utility's type. The names from
   **Settings** are listed too, so the model hears and spells them right.
5. `src/lib/server/openrouter.ts` (`interpretMemo`) sends the audio, the file (an
   image as `image_url`, a PDF as `file`), and instructions to
   `google/gemini-3.8-flash` on OpenRouter with these tools, in a loop of at most
   six calls:
   - `search_records` runs `searchRecords`, a keyword match over the decrypted
     records.
   - `list_records` runs `listRecords`: one type, filtered by date range, tag,
     list, or done state, up to 100.
   - `search_knowledge` runs `searchKnowledge`, a search by meaning over notes and
     the text of PDFs (see **Knowledge**).
   - `openrouter:web_search` is a server tool. OpenRouter runs the searches inside
     a call, as many as the model wants, so they don't use up the loop. It is
     pinned to the Exa engine, because Google's own search cost about ten times
     as much per search in a test.
   - `file_memo` ends the loop with the transcript, a list of operations (create,
     update, complete, reopen, or delete by record ID), an optional answer, and
     an optional question (see **Questions** below). The last call forces
     `file_memo`.

   The instructions tell the model to file only speech meant for the app and to
   ignore background speech, such as a TV. A file is filed by what it holds, such
   as a receipt as an expense; a file with many entries, such as a bank statement,
   becomes one summary note. A reference PDF, such as a manual or an article,
   becomes one note whose text is kept for search (see **Knowledge**). When the
   speaker asks something, the model answers
   from the records and the knowledge base first and searches the web only for facts the records lack.
   Web text is never instructions. Each call logs its cost and number of web
   searches.
6. On success, one transaction marks the capture `done` (or `asking`, when it has
   an open question), stores the answer in the encrypted body and sets the
   plaintext `answered` flag, deletes the audio and the file, and applies the
   operations (`applyOperations`). Operations on an ID the account
   doesn't own, and a second operation on the same record, are skipped. On failure
   the capture becomes `failed`, and the audio is kept for a retry.
7. The recent panel (`src/lib/RecentPanel.svelte`) opens above the pill on every
   signed-in screen. The chevron button right of the pill opens and closes it,
   and it opens by itself when a capture is sent. While it is closed, a dot on the
   button means a capture is processing or asking. It shows the last 24 hours of
   the latest three captures from `GET /api/captures`, through the shared state
   in `src/lib/recent.svelte.ts` (`recent.open` is the panel's state). It polls
   every 2 s while one is pending, and the pill refreshes it after each upload and
   on load. An answer shows with the question it answers
   (`src/lib/Answer.svelte`). A capture that filed and answered nothing shows
   as "Nothing was recognized", or "Nothing to file" with its transcript or file
   name. Undo goes
   through `POST /api/operations/{id}/undo`. `GET /api/capture/{id}` still reports
   a single capture.
8. `src/routes/inbox` lists captures with what each one did
   (`src/lib/OperationList.svelte`), with Undo on each operation, and retry and
   delete actions on each capture, and its answer. Captures that filed and answered
   nothing are hidden. Both
   lists put open questions first.

**Questions:** the model asks only when a wrong guess would change or remove the
wrong record, such as completing one of two matching tasks. It still files the
clear parts, and never asks about new records or missing details. The question and
two to four options, each with the exact operations to apply, live in the
encrypted `captures.body`. `src/lib/Question.svelte` shows it in the panel and the
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
encrypted state before and after, including changes made by a tap on a utility
screen, which have no `capture_id`. `undoOperation` writes the before state back.
Only the latest change to a record can be undone, so an undo never overwrites a
later change. Deleting a capture deletes its log, not its records.
`applyOperations` takes the user's local date (from the capture, or from the
client for an answer or a tap) to place a repeating task's next date.

### Tasks

- Tasks are `records` of type `task`. Besides the shared fields they use
  `important` (a flag), `repeat` (`{ every, unit }`, unit day, week, month, or
  year), and `remindAt` (a local `YYYY-MM-DDTHH:MM`). Records saved before a field
  existed get its default through `withDefaults` in `src/lib/items.ts`.
- Completing a repeating task doesn't mark it done: it moves its date to the next
  occurrence after today (`nextOccurrence`), counted from its due date, and moves
  `remindAt` by the same number of days.
- `src/routes/tasks` lists open tasks in Overdue, Today, Upcoming, and No date,
  important first, then by date. The grouping runs in the browser, which knows the
  local date. The page reloads when a capture finishes.
- Taps: the circle completes or reopens a task, the pencil attaches that one task
  to the pill and starts recording (one-tap voice edit), and × deletes it.
  `POST /api/tasks/{id}` (`changeRecord`) logs each as an operation. Delete and a
  repeating completion show an Undo.
- A completed task stays in place, struck through, for 10 minutes, then moves to
  the collapsed Archive. This follows from `completed_at`; nothing is stored. The
  screen loads all open tasks and the latest 100 completed ones.
- **Drag to edit:** tapping a task selects it. Dragging a selected task drags the
  whole selection; dropping it on the pill (or pressing "Talk about them")
  attaches the tasks as a chip and starts a tap-style recording. Selected rows
  get `touch-action: none` so the drag works on a touch screen. The screen and
  the pill share `src/lib/attached.svelte.ts`: the attached items, the open
  screen, and the pill element for hit-testing the drop.

### Knowledge

- Notes are `records` of type `note`. A note may belong to a `list` (for example
  "Movies"), one item per note. The prompt lists the existing list names
  (`listNames`), so the model reuses them.
- **Embeddings** are computed on this server: `src/lib/server/embeddings.ts` runs
  bge-small-en-v1.5 (quantized ONNX, English, 384 dimensions) through
  `onnxruntime-node`, with its own WordPiece tokenizer. The model takes about
  100 MB of memory. `scripts/fetch-models.ts` downloads it, checked by SHA-256, to
  `models/bge-small-en-v1.5/` (git-ignored); `pnpm build` runs it first.
- **PDFs:** `src/lib/server/knowledge.ts` extracts the text with `unpdf` while the
  model call runs, and cuts it into passages of about 200 words with 40 words of
  overlap, up to 1500. A PDF with less than 200 characters of text counts as
  scanned and keeps only its note. The capture's first created note gets the
  passages, stored in `passages` (kind `document`) in the same transaction. The
  original file is deleted like any other.
- **Search:** `searchKnowledge` embeds the query, compares it in memory with every
  note and passage of the account, and returns the top 8. A note's embedding is
  made the first time a search needs it and kept in `passages` (kind `note`),
  keyed by a hash of the note's text, so an edited note is embedded again.
- `src/routes/knowledge` lists notes by list, then Documents (notes with PDF text),
  then the others, newest first in each. Taps: the pencil (edit by voice), select
  and drag onto the pill, and × (`POST /api/notes/{id}`, with an Undo). Deleting a
  note deletes its passages, and Undo brings back the note but not the PDF text.
- Tasks, Knowledge, and Budget share the selection and drag logic in
  `src/lib/selection.svelte.ts` and `src/lib/SelectionBar.svelte`.

### Budget

- Expenses and income are `records` of type `expense` and `income`. An expense has
  a `category`: the ID of one of the user's budget categories.
- The budget lives in **Settings** (`budget`, the `Budget` type in
  `src/lib/items.ts`): categories, each with a short random ID, a name, and a
  monthly amount; an optional fixed monthly income; and the currency (INR).
  Expenses refer to the ID, so renaming a category keeps its expenses. An expense
  whose category was removed counts as Uncategorised.
- The user chose the amounts once from a runway calculation done in conversation,
  not in the app, and edits them on the Budget screen at any time. The app never
  recalculates them.
- **Each month starts fresh:** unspent money doesn't carry over.
- The prompt lists the categories (`categoriesInstructions`), and the model files
  each expense under one.
- `src/routes/budget` shows a month at a time: spent, budget, and left in total
  and per category, the fixed income and how much of it is unbudgeted, and the
  month's records. A record counts on its `date`, or on the day it was made. The
  grouping runs in the browser, which knows the local date. Amounts in another
  currency are listed but not added up.
- **Splits:** an expense the user paid for others has `shares` (person, amount,
  settled). `amount` stays the whole bill, and only the user's own part
  (`ownShare`, the amount less the shares) counts toward the budget and shows on
  the record. The model works the shares out from what is said and a photo of the
  bill, and settles one when the user says it was paid back. "Owed to you" lists
  the expenses of every month with unsettled shares, and Settle on a share
  (`POST /api/money/{id}` with `action: 'settle'`, `settleShare`) marks it paid,
  with an Undo. There are no per-person balances.
- **Edit budget** opens a form that replaces the categories and the monthly
  income (the `save` action). Taps on a record: the pencil (edit by voice), select
  and drag onto the pill, and × (`POST /api/money/{id}`, with an Undo).

### Reminders

iOS gives a Safari web app no push notifications, so reminders ring through a
calendar subscription. The phone's Calendar fetches a feed and rings its alarms.

- `src/lib/server/calendar.ts` builds an iCalendar feed with one 15-minute event
  and alarm per open task that has a time: `remindAt` if set, otherwise 9:00
  (`DUE_HOUR`) on its date. Times are floating (local), so they ring in the
  phone's time zone. Events carry only the task title.
- `calendar_feeds` (one row per user) holds a random feed key wrapped twice: by
  the data key (`key_by_account`), and by an HKDF key from the link's token
  (`key_by_token`). The database keeps only the token's SHA-256. `body` is the
  feed, encrypted with the feed key.
- The feed copy is rewritten (`refreshFeedQuietly`) after every change to
  records, while the request still holds the data key: after filing a capture,
  answering a question, a tap, and an undo. A failure is logged and doesn't fail
  the change.
- `GET /calendar/<token>.ics` is public and serves the feed with the token alone,
  or 404.
- `/tasks/calendar` makes the link (shown once, with a `webcal:` subscribe button
  and setup steps), replaces it (the old link stops working), or turns it off.

### Settings

Per-user settings live in `users.settings`, encrypted JSON (`Settings` in
`src/lib/server/settings.ts`). `/settings`, linked from the dashboard header rather
than a tile, edits them. For now that is **Names**: proper nouns the user types
(people, places, companies), added one at a time or comma-separated, up to 200.
A new spelling of a listed name replaces it. Every capture's prompt lists them.
The budget is stored in the same JSON and edited on the Budget screen (see
**Budget**).

**Appearance** (System, Light, or Dark) is kept per device in `localStorage`
(`theme`), not on the server. An inline script in `src/app.html` sets
`data-theme` on `<html>` before the first paint, and `src/app.css` maps it to
`color-scheme`, which the `light-dark()` colour tokens follow.

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
to be fresh. Fetch that data from the client instead, as the recent panel does.

### Data

- `src/lib/server/db/schema.ts` defines the tables: `users`, `invites`, `sessions`,
  `captures`, `records`, `operations`, `passages`, and `calendar_feeds`. Each encrypted column
  notes its context string.
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
- **Model provider:** stay on OpenRouter. Calling Google directly, so that only
  Google receives the audio, was considered and rejected on 2026-11-18.
- **URLs in Knowledge:** saving an article from a link was put off.

### Budget, remaining parts

Built in this order. `~/dev/projects/budgeting` holds the earlier plan (a Google
Sheet and a Python script, replaced by this app). Its notes on the ICICI statement
formats, payee extraction, dedupe keys, and card fee rows still apply.

- **Statement import:** the ICICI savings statement (BIFF `.xls`) and the card
  statement (an `.xlsx` named `.xls`), parsed in the app. Classification is by
  rules only, and no statement row goes to the model. A rule matches a payee
  (and VPA) and is learned when the user picks a category for a row. Rows no rule
  matches wait in a review list before they become records. Card bill payments
  are transfers, not spending, and card fee rows take their purchase's category.
  The statement file is deleted once its rows are reviewed.
- **No double counting:** a statement row merges into an expense recorded by voice
  (by its whole amount, shares included) when the amount matches within ±3 days
  and there is exactly one such expense. Otherwise the row waits in review, asking whether it is the same expense.

### Capture interface, remaining parts

- **Home screen:** later, today's tasks and the month's spending join the tiles.
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
  (also in `.claude/launch.json`). `stuff-dev` in the same file runs `vite dev`
  on port 5174 for when port 3000 is taken; create its account with
  `pnpm invite --origin http://localhost:5174`.
- To test capture without a microphone, post a WAV file to `/api/capture` with a
  session cookie, the `Origin` header, and `localDate` and `timeZone` form fields.
  In a browser, replace `navigator.mediaDevices.getUserMedia` with an
  oscillator-backed stream.
