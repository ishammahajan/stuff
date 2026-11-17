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

### Requests and auth

- `src/hooks.server.ts`: `handle` requires a session for every path except `/login`.
  Pages redirect to `/login`, and `/api/*` returns 401 JSON. `init` resumes captures
  left pending by a restart.
- `src/lib/server/auth.ts`: single password login (`APP_PASSWORD_HASH`), sessions,
  and a global failed-login throttle. The cookie holds a random token, and the
  database stores only its SHA-256.
- `src/lib/server/password.ts`: scrypt hashing (`salt:key` in hex).
- CSRF protection is SvelteKit's origin check, so production needs `ORIGIN` set.

### Voice capture pipeline

1. `src/lib/Recorder.svelte` (on the dashboard) records with `MediaRecorder`.
   `src/lib/audio.ts` converts the recording to 16 kHz mono 16-bit WAV.
2. `POST /api/capture` (`src/routes/api/capture/+server.ts`) validates the upload,
   stores the audio in `captures.audio`, starts processing, and returns `202 {id}`.
3. `src/lib/server/captures.ts` processes in the background. It keeps an in-process
   set of captures in progress, so one capture never gets two model calls.
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
`src/lib/ItemList.svelte` renders items. Items are stored only as JSON on the capture
for now. No utility tables exist yet.

### Offline and startup speed

`src/service-worker/index.ts` keeps one cache per deployment (`stuff-${version}`):

- Built and static files are cache-first.
- The dashboard (`/`) is stale-while-revalidate, so it opens at once. The first open
  after a deploy can show the previous version.
- A cached dashboard is dropped when the session ends.

Because the dashboard HTML can be stale, it must not render server data that needs
to be fresh. Fetch that data from the client instead, as the capture notes do.

### Data

- `src/lib/server/db/schema.ts` defines the tables: `sessions` and `captures`.
- To change the schema, edit `schema.ts`, run `pnpm db:generate`, and commit the SQL
  in `drizzle/`. `pnpm start` applies migrations (`scripts/migrate.ts`) before the
  server starts, locally and on Railway.

## Adding a utility (current pattern)

1. Add its route under `src/routes/<name>/` and give its dashboard tile an `href`
   in `src/routes/+page.svelte`.
2. If voice should create its items, add the type to `ITEM_TYPES` and `Item` in
   `src/lib/items.ts`. Then update the JSON schema and the instructions in
   `src/lib/server/openrouter.ts`, and the rendering in `ItemList.svelte`.
3. Add its tables to `schema.ts`, and generate a migration.
4. Update this file.

This pattern changes once the decisions below are built.

## Decided, not built yet

Remove each point from this section as it lands, and describe the result in **Map**.

- **Accounts:** multiple users, each with private data. Login uses a password only
  (no name field). Every row belongs to a user, and every query is scoped to the
  signed-in user. There is no admin view of other users' data.
- **Encryption:** user data is encrypted at rest. The design is not settled yet.
- **Edits from voice:** the model returns operations (create, update, complete,
  delete by ID) instead of only new items. Every operation is shown in the inbox
  with an undo.
- **Context for the model:** a small, bounded snapshot of current data in the prompt
  (static maps such as budget categories, plus a capped list of active items), and a
  search tool the model can call. The input is audio, so there is no text to embed
  before the call: retrieval happens only through that tool, backed by embeddings.
- **Order:** accounts and encryption, then operations, context, and undo, then the
  Tasks, Knowledge, and Budget utilities.
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
  `APP_PASSWORD_HASH`, `OPENROUTER_API_KEY`, and `BODY_SIZE_LIMIT=10M`.
- Don't add `railway.json` or `railway.toml`. Railway stops reading them on
  2026-12-01. Railpack detects the `build` and `start` scripts on its own.

## Local development

- Database: `docker compose up -d` (Postgres 18 on `127.0.0.1:5433`). If Docker
  can't create its network (this machine's kernel has had that problem), run a
  throwaway database on the host network instead:
  `docker run -d --rm --name stuff-db-temp --network host -e POSTGRES_USER=stuff -e POSTGRES_PASSWORD=stuff -e POSTGRES_DB=stuff postgres:18-alpine -p 5433 -c listen_addresses=127.0.0.1`
- `.env` holds `DATABASE_URL`, `APP_PASSWORD_HASH`, and `OPENROUTER_API_KEY`. It
  is git-ignored. Never print or commit its values.
- To test the production build, run `pnpm build`, then
  `env ORIGIN=http://localhost:3000 PORT=3000 BODY_SIZE_LIMIT=10M node --env-file=.env build`
  (also in `.claude/launch.json`).
- To test capture without a microphone, post a WAV file to `/api/capture` with a
  session cookie, the `Origin` header, and `localDate` and `timeZone` form fields.
  In a browser, replace `navigator.mediaDevices.getUserMedia` with an
  oscillator-backed stream.
