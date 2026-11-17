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

3. Copy `.env.example` to `.env`, and set `OPENROUTER_API_KEY`.

4. Apply the database migrations:

   ```sh
   pnpm db:migrate
   ```

5. Start the dev server:

   ```sh
   pnpm dev
   ```

6. Create an account. This prints a one-time sign-up link; open it and choose a
   password:

   ```sh
   pnpm invite --origin http://localhost:5173
   ```

## Commands

| Command            | Purpose                                                        |
| ------------------ | -------------------------------------------------------------- |
| `pnpm dev`         | Run the dev server.                                            |
| `pnpm check`       | Type-check the app and the service worker.                     |
| `pnpm build`       | Build for production into `build/`.                            |
| `pnpm start`       | Apply migrations, then run the production build.               |
| `pnpm db:generate` | Generate a SQL migration after changing the schema.            |
| `pnpm db:migrate`  | Apply pending migrations.                                      |
| `pnpm invite`      | Print a one-time sign-up link for a new account.               |

The production server also needs two more variables:

- `ORIGIN`: the site's URL, for example `ORIGIN=https://example.com`, so that form
  submissions pass the origin check.
- `BODY_SIZE_LIMIT=10M`: the default limit of 512 kB is too small for voice recordings.

## How it fits together

`CLAUDE.md` maps the design: accounts and encryption, the voice capture pipeline,
caching, data, and how to add a utility.
