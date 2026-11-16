# Stuff

A personal dashboard of small utilities, built with SvelteKit and Postgres.

## Local setup

1. Install dependencies:

   ```sh
   pnpm install
   ```

2. Start the development database:

   ```sh
   docker compose up -d
   ```

3. Copy `.env.example` to `.env`, then set `APP_PASSWORD_HASH` to the output of:

   ```sh
   pnpm hash-password
   ```

4. Apply the database migrations:

   ```sh
   pnpm db:migrate
   ```

5. Start the dev server:

   ```sh
   pnpm dev
   ```

## Commands

| Command              | Purpose                                              |
| -------------------- | ---------------------------------------------------- |
| `pnpm dev`           | Run the dev server.                                  |
| `pnpm check`         | Type-check the app and the service worker.           |
| `pnpm build`         | Build for production into `build/`.                  |
| `pnpm start`         | Apply migrations, then run the production build.     |
| `pnpm db:generate`   | Generate a SQL migration after changing the schema.  |
| `pnpm db:migrate`    | Apply pending migrations.                            |
| `pnpm hash-password` | Hash a login password for `APP_PASSWORD_HASH`.       |

The production server also needs two more variables:

- `ORIGIN`: the site's URL, for example `ORIGIN=https://example.com`, so that form
  submissions pass the origin check.
- `BODY_SIZE_LIMIT=10M`: the default limit of 512 kB is too small for voice recordings.

## How it fits together

- `src/hooks.server.ts` requires a session for every route except `/login`.
- `src/lib/server/auth.ts` handles login, sessions, and the failed-login throttle.
- `src/lib/server/db/schema.ts` defines the database tables.
- `src/service-worker/index.ts` caches the app's files and the dashboard page so the
  dashboard opens at once on repeat visits.
- `src/routes/capture` records a voice memo and uploads it as WAV to `/api/capture`.
- `src/lib/server/openrouter.ts` sends the recording to Gemini through OpenRouter, which
  returns a transcript and a list of items (task, note, expense, or income).
- `src/routes/inbox` lists captures and lets you retry or delete them.
- `src/routes/+page.svelte` is the dashboard. Add a utility by giving its tile an `href`.
