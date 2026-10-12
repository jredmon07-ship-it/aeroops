# Self-hosting AeroOps

This guide sets up your own copy of AeroOps for one flight school, club, or FBO.
It is written for whoever handles IT at the operation.

Every command here was run end to end on a fresh clone against an empty
Postgres 16 database (October 2026). Where a value depends on your setup
(host names, passwords, ports), the guide says so. The Vercel and Neon click
paths in step 8 were not re-run for this guide.

---

## What you need

- **Node 20 or newer.** Check with `node -v`.
- **pnpm 9.** It comes with Node through corepack. Run `corepack enable` once.
  The repo pins the exact version (`pnpm@9.12.0`), so corepack picks it up.
- **A Postgres database, version 14 or newer.** Either:
  - a free [Neon](https://neon.tech) project (works with Vercel hosting), or
  - Postgres on your own machine or server.
- **`psql`**, the Postgres command-line client, for one setup command.
  On Neon you can use the SQL Editor in the Neon console instead.
- **`openssl`**, to generate secrets. It is preinstalled on macOS and Linux.

---

## 1. Get the code

```bash
git clone https://github.com/jredmon07-ship-it/aeroops.git aeroops
cd aeroops
pnpm install --frozen-lockfile
```

All later commands run from this `aeroops` folder.

---

## 2. Create the database and the two roles

AeroOps uses **two database logins**. This is the step people most often get wrong.

| Login | What it is for | Where it goes |
|---|---|---|
| **Owner** (Neon: `neondb_owner`; local: `postgres` or your admin user) | Creating and updating tables (migrations). | Only on the command line, when you run migrations. |
| **`aeroops_app`** | The running app. It can read and write data but cannot change tables or skip the per-operation data rules. | The app's `DATABASE_URL`. |

Why: every table has row-level security, which keeps each operation's data
separate. A superuser skips those rules. The app checks this on startup and
refuses to work if it is connected as a superuser.

### 2a. Create an empty database

**Neon:** New Project → name it `aeroops`. On the project dashboard, copy the
connection string. It looks like
`postgresql://neondb_owner:PASSWORD@HOST.neon.tech/neondb?sslmode=require`.
This is your **owner string**.

**Local Postgres:**

```bash
createdb aeroops
```

Add `-h`, `-p`, and `-U` if your install needs them. Your owner string is then something like
`postgres://postgres@127.0.0.1:5432/aeroops` (adjust user, password, and port
to your install).

The `aeroops_app` login does not exist yet. Migration `0000` creates it in step 4.
You give it a password in step 4c.

---

## 3. Configure environment variables

The web app reads its settings from **`apps/web/.env.local`**.
A `.env.local` in the repo root is **not** read by the app.

Create `apps/web/.env.local` with:

```
DATABASE_URL=postgres://aeroops_app:APP_PASSWORD@HOST:5432/aeroops
AUTH_SECRET=PASTE_A_GENERATED_SECRET
ALLOW_SIGNUP=true
```

Fill in `APP_PASSWORD` after step 4c. Generate `AUTH_SECRET` with:

```bash
openssl rand -base64 32
```

| Variable | Required | Value |
|---|---|---|
| `DATABASE_URL` | Yes | The **`aeroops_app`** connection string. Never the owner string. On Neon, add `?sslmode=require`. |
| `AUTH_SECRET` | Yes | Output of `openssl rand -base64 32`. Signs logins and login links. If you change it, everyone is signed out and every unused login link stops working. |
| `ALLOW_SIGNUP` | No | `true` turns on the `/signup` page that creates a new operation. Anything else, or unset, means off. Turn it on only while you create your operation (step 6). |
| `AUTH_TRUST_HOST` | No | Not needed. The app already trusts the host header. Setting it to `true` is harmless. |

Never commit `.env.local`. It is already in `.gitignore`.

---

## 4. Run migrations

Migrations create the tables. They run as the **owner**. Pass the owner string
on the same line as the command, so it does not stay in your shell (see
Troubleshooting: "connected as a superuser").

### 4a. Preview (changes nothing)

```bash
DATABASE_URL='OWNER_STRING' pnpm db:migrate
```

It lists every pending migration and ends with `DRY RUN — no changes made.`
The SQL files are in `packages/db/migrations/` if you want to read them.

### 4b. Apply

```bash
DATABASE_URL='OWNER_STRING' CONFIRM_APPLY=1 pnpm db:migrate:apply
```

On an empty database this applies all migrations and ends with
`All pending migrations applied successfully.`

### 4c. Let `aeroops_app` log in and give it a password

Migration `0000` creates `aeroops_app` **without** the right to log in.
Turn that on and set a password in one command. Use a password made of letters
and digits only, so it can go in a connection string without escaping:

```bash
openssl rand -hex 24
psql 'OWNER_STRING' -c "ALTER ROLE aeroops_app WITH LOGIN PASSWORD 'PASTE_THE_PASSWORD';"
```

On Neon you can run the same `ALTER ROLE` line in the SQL Editor instead.

Check it works. Your app string is the owner string with the user and password
swapped for `aeroops_app` and the new password:

```bash
psql 'postgres://aeroops_app:APP_PASSWORD@HOST:5432/aeroops' -c "select current_user, current_setting('is_superuser');"
```

You should see `aeroops_app | off`. Put this string in `DATABASE_URL` in
`apps/web/.env.local`.

---

## 5. Run it on your computer

Use a terminal where `DATABASE_URL` is **not** exported (see Troubleshooting).

Development mode:

```bash
pnpm dev
```

Open http://localhost:3000. Add `--port 3001` (`pnpm dev --port 3001`) if 3000 is taken.

Production mode:

```bash
pnpm build
pnpm --filter @aeroops/web exec next start -p 3000
```

There is no `pnpm start` shortcut; use the second line as written.
If you run `pnpm dev` after `pnpm build`, run `pnpm build` again before `next start`.

---

## 6. Create your operation

1. Make sure `ALLOW_SIGNUP=true` is in `apps/web/.env.local` and the app is running.
2. Open http://localhost:3000/signup.
3. Enter the operation name, your name, your email, and a password (at least 10
   characters). Accept the terms and click **Create operation**.
4. You are signed in as the **owner** and taken to the setup page.
5. Your sign-in page is `/o/YOUR-SLUG/login`. The slug is made from the
   operation name. For "Prairie Flying Club" it is `prairie-flying-club`.
   Bookmark it.
6. Turn signup off: delete the `ALLOW_SIGNUP` line (or set it to `false`) and
   restart the app. `/signup` then says signup is off, and the signup form is
   refused on the server too.

---

## 7. Give staff and members their logins

AeroOps does not send email. You create a link and send it yourself.

1. Sign in as the owner (or a manager).
2. Go to **People** → **Add member**. Enter their name, email, and role
   (Owner, Manager, Dispatcher, CFI, Mechanic, Renter, Student, Accountant).
3. Open that member's page and click **Create login link**.
4. Click the copy button. Send the link by text or email.
5. The member opens the link, chooses a password (at least 10 characters),
   and signs in at `/o/YOUR-SLUG/login` with their email and that password.

Rules worth knowing:

- A link works **once** and expires after **7 days**.
- If the member already has a password, the button says **Create reset link**.
  Use it when someone forgets their password.
- Creating a new link, or the member setting a password, makes older links stop working.
- Only an owner can create links for owners and managers.
- Deactivated members cannot get links.
- Every link created and used shows up in the Activity log.

---

## 8. Put it online with Vercel and Neon

These steps were not re-run for this guide. Steps 2 to 4 above were.

1. Do steps 2 to 4 against your **Neon** database from your own computer.
   That creates the tables and the `aeroops_app` password.
2. Push your copy of the code to a GitHub repository you control.
3. In Vercel: **Add New → Project → Import** that repository.
4. Set **Root Directory** to `apps/web`. Framework preset: **Next.js** (detected).
   Leave the build command as is.
5. Under **Environment Variables**, add:
   - `DATABASE_URL` = the **`aeroops_app`** Neon string (with `?sslmode=require`).
     Never the `neondb_owner` string.
   - `AUTH_SECRET` = a new `openssl rand -base64 32` value.
   - `ALLOW_SIGNUP` = `true` (for now).
6. Click **Deploy**.
7. Open `https://YOUR-APP.vercel.app/signup` and create your operation (step 6).
8. In Vercel, delete `ALLOW_SIGNUP` (Settings → Environment Variables), then
   **Deployments → ⋯ → Redeploy** so the change takes effect.
9. Give staff logins (step 7). Links use your Vercel address.

Do not set `AEROOPS_DEMO`, `AEROOPS_DEMO_RESET_ENABLED`, or
`AEROOPS_DEMO_OWNER_URL`. They are for the public demo only; see `DEPLOY.md`.

---

## 9. Updating to a new version

```bash
git pull
pnpm install --frozen-lockfile
DATABASE_URL='OWNER_STRING' pnpm db:migrate
DATABASE_URL='OWNER_STRING' CONFIRM_APPLY=1 pnpm db:migrate:apply
```

1. Run the dry run first and read what it will apply. If it says
   `All migrations already applied. Nothing to do.`, skip the apply line.
2. Back up the database before applying (Neon: create a branch or use its restore).
3. Apply, then restart the app (local) or push to GitHub (Vercel redeploys).
4. Each migration has a `.down.sql` file for manual rollback. Nothing runs it
   automatically. See "Rollback plan" in `DEPLOY.md`.

---

## 10. Troubleshooting

These are the problems hit while testing this guide.

**`/signup` says "Signup is turned off" even though I set `ALLOW_SIGNUP=true`.**
The setting is in the wrong file, or the app was not restarted. It must be in
`apps/web/.env.local`, not a `.env.local` in the repo root. Restart after editing.

**`FATAL: role "aeroops_app" is not permitted to log in`.**
You set a password without `LOGIN`. Run
`ALTER ROLE aeroops_app WITH LOGIN PASSWORD '...';` as the owner (step 4c).

**Sign-in fails, the browser lands on `/api/auth/error?error=Configuration`, and
the server log says `connected as a superuser role`.**
The app is using the owner login. Check `DATABASE_URL` in `apps/web/.env.local`.
Also check your shell: a `DATABASE_URL` **exported** in the terminal overrides
`.env.local`. Run `unset DATABASE_URL` and restart, or open a new terminal.
This is why step 4 passes the owner string on the same line instead of exporting it.

**`permission denied for schema public` when running migrations.**
You ran migrations with the `aeroops_app` string. Use the owner string.

**`AUTH_SECRET is the build-time placeholder` in the log, and sign-in returns 500.**
`AUTH_SECRET` is missing at runtime. Add it to `apps/web/.env.local` (or the
Vercel environment variables) and restart or redeploy.

**`Could not find a production build in the '.next' directory`.**
`pnpm dev` and `pnpm build` share the `.next` folder. Run `pnpm build` again
before `next start`.

**`Missing script start` from `pnpm start`.**
There is no start script. Use `pnpm --filter @aeroops/web exec next start -p 3000`.

**A login link says it is no longer valid.**
It was already used, it expired, a newer link was created, the member was
deactivated, or `AUTH_SECRET` changed. Create a new link.

**`pnpm db:seed:demo` fails with `tsx: command not found`.**
The demo seed is optional; you do not need it for a real operation. If you want
the two sample operations (`alpha`, `bravo`) on a test database, run it through
`pnpm dlx` instead (owner string, test database only):

```bash
DATABASE_URL='OWNER_STRING' ALLOW_DEMO_SEED=1 pnpm --filter @aeroops/api exec pnpm dlx tsx@4.19.2 scripts/seed-demo.ts
```

Sample logins are in `DEMO.md`. Login links are disabled for these two sample operations.

**Local Postgres will not start: `Unix-domain socket path ... is too long`.**
Only happens when the data or socket folder has a very long path. Start it with
TCP only: `pg_ctl -D DATADIR -o "-p 5432 -k '' -c listen_addresses=127.0.0.1" start`,
and connect with `-h 127.0.0.1`.
