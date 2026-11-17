# Stuff

A personal app of small utilities (tasks, knowledge, budget), opened from the iPhone
action button. Speech is the main input: the user records a voice memo, and a model
turns it into items for the utilities. Human setup steps are in `README.md`.

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
  password, and then sees their recovery code once. `--owner` makes the new account
  adopt captures from before accounts existed (`adoptUnownedCaptures`).
- `/recover` takes a recovery code and a new password, re-wraps the key, and signs
  the account out everywhere else.
- `src/lib/PasswordField.svelte` is the password input with a Show/Hide toggle.
- CSRF protection is SvelteKit's origin check, so production needs `ORIGIN` set.

### Voice capture pipeline

1. `src/lib/Recorder.svelte` (on the dashboard) records with `MediaRecorder`.
   `src/lib/audio.ts` converts the recording to 16 kHz mono 16-bit WAV.
2. `POST /api/capture` (`src/routes/api/capture/+server.ts`) validates the upload,
   stores the encrypted audio in `captures.audio`, starts processing, and returns
   `202 {id}`. The local date, time zone, transcript, items, and error live in the
   encrypted `captures.body` JSON.
3. `src/lib/server/captures.ts` processes in the background with the account's key.
   It keeps an in-process set of captures in progress, so one capture never gets
   two model calls. After a restart, a pending capture resumes when its owner polls
   it or opens the inbox.
4. `src/lib/server/openrouter.ts` sends the audio and instructions to
   `google/gemini-3.8-flash` on OpenRouter in a single call, with a strict JSON
   schema. The reply is a transcript plus items.
5. On success the capture becomes `done`, the items are saved, and the audio is
   deleted. On failure it becomes `failed`, and the audio is kept for a retry.
6. The dashboard (`src/routes/+page.svelte`) polls `GET /api/capture/{id}` every 2 s
   for the IDs it sent. It keeps those IDs in `localStorage`, so it still reports
   results after the app is closed and reopened.
7. `src/routes/inbox` lists captures, with retry and delete actions.

Item types and the shared shapes live in `src/lib/items.ts`.
`src/lib/ItemList.svelte` renders items. Items are stored only inside the capture's
encrypted body for now. No utility tables exist yet.

### Offline and startup speed

`src/service-worker/index.ts` keeps one cache per deployment (`stuff-${version}`):

- Built and static files are cache-first.
- The dashboard (`/`) is stale-while-revalidate, so it opens at once. The first open
  after a deploy can show the previous version.
- A cached dashboard is dropped when the session ends.

Because the dashboard HTML can be stale, it must not render server data that needs
to be fresh. Fetch that data from the client instead, as the capture notes do.

### Data

- `src/lib/server/db/schema.ts` defines the tables: `users`, `invites`, `sessions`,
  and `captures`. Each encrypted column notes its context string.
- `captures` still has plaintext columns (`local_date`, `time_zone`, `transcript`,
  `items`, `error`) from before accounts existed. They are empty once the owner's
  account has adopted the old captures. Drop them in a later migration.
- To change the schema, edit `schema.ts`, run `pnpm db:generate`, and commit the SQL
  in `drizzle/`. `pnpm start` applies migrations (`scripts/migrate.ts`) before the
  server starts, locally and on Railway.

## Adding a utility (current pattern)

1. Add its route under `src/routes/<name>/` and give its dashboard tile an `href`
   in `src/routes/+page.svelte`.
2. If voice should create its items, add the type to `ITEM_TYPES` and `Item` in
   `src/lib/items.ts`. Then update the JSON schema and the instructions in
   `src/lib/server/openrouter.ts`, and the rendering in `ItemList.svelte`.
3. Add its tables to `schema.ts`, and generate a migration. Every table of user
   data gets a `user_id`, and every content column is encrypted, as described under
   **Accounts, sessions, and encryption**.
4. Update this file.

This pattern changes once the decisions below are built.

## Decided, not built yet

Remove each point from this section as it lands, and describe the result in **Map**.

- **Data model:** one `records` table shared by all utilities. Each row has a user,
  a type, timestamps, and an encrypted body. A record can be any small document: a
  task, a budget category with its allocation, a transaction that references a
  category by ID, or a statement import. Totals and searches run in memory after
  decryption. A utility may get its own table when the shared table doesn't fit,
  for example for large files.
- **Edits from voice:** the model returns operations (create, update, complete,
  delete by ID) instead of only new items. Operations are applied in a transaction
  and logged with the before and after state, so each one can be undone.
- **Context for the model:** a bounded snapshot in the prompt, plus a search tool.
  Each utility may add static maps (such as budget categories) and a capped list of
  active items, or nothing at all. The model is told the snapshot is partial. The
  input is audio, so there is no text to embed before the call: retrieval happens
  only through the search tool, backed by embeddings.
- **Speech meant for the app:** every recording is sent; there is no silence
  detection in the browser. The instructions tell the model to file only what the
  speaker directs at the app and to ignore background speech, such as a TV.
  Recordings with nothing to file are hidden from the recent strip and the inbox.
- **Order:** the data model, operations, context, and undo, then the capture
  interface below, then the Tasks, Knowledge, and Budget utilities.

### Capture interface (decided)

- **The pill:** a rounded pill at the bottom centre of every screen, in the shared
  layout, so recording continues across navigation. It shows a flat line when idle
  and the live waveform while recording.
- **Tap:** tap to start, and tap again to stop and send. Recording never stops
  because of silence.
- **Hold:** pressing longer than about 300 ms records like a walkie-talkie and sends
  on release.
- **Space bar:** on a desktop, a quick press of Space works like a tap, and holding
  Space works like holding the pill.
- **Discard:** while recording, a × next to the pill throws the recording away.
  Swiping the pill down does the same.
- **Limit:** recordings stop and send at 3 minutes.
- **No auto-record:** opening the app never starts a recording. The app is a
  dashboard first; the action button opens it, and recording always starts from
  the pill or the space bar.
- **Drag to edit:** on a utility screen, dragging one or more selected items onto
  the pill attaches them as chips and starts a tap-style recording. The model
  receives them as the items being talked about. Recording on a utility's screen
  also leans the model toward that utility.
- **Home screen:** an overview (utility tiles now, and later today's tasks and the
  month's spending). Above the pill, a recent strip shows the last few results with
  Undo, and answers to questions. The inbox keeps the full history.
- **Tabs on iPhone:** a page can't close a Safari tab it didn't open, and Shortcuts
  can't open a Home Screen web app, so the app runs in Safari. The action-button
  Shortcut opens the plain site URL, and Safari reuses the open tab when the same
  URL is opened again, which keeps tabs from piling up. Don't make the dashboard
  rewrite its own URL (for example with query parameters), or the next press opens
  a new tab.
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
  `OPENROUTER_API_KEY`, and `BODY_SIZE_LIMIT=10M`.
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
  `env ORIGIN=http://localhost:3000 PORT=3000 BODY_SIZE_LIMIT=10M node --env-file=.env build`
  (also in `.claude/launch.json`).
- To test capture without a microphone, post a WAV file to `/api/capture` with a
  session cookie, the `Origin` header, and `localDate` and `timeZone` form fields.
  In a browser, replace `navigator.mediaDevices.getUserMedia` with an
  oscillator-backed stream.
