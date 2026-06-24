# Deploying latch-platform to Vercel

TanStack Start app. It auto-detects Vercel at build (via the `VERCEL` env) and
emits a Nitro Vercel function — no target config needed. Set the project **Root
Directory** to `apps/latch-platform`.

## 1. Database (required — no file DB on Vercel)

Vercel's filesystem is ephemeral, so the dev default `file:./latch.db` won't
work. Use a hosted libsql (Turso) or Postgres. For Turso:

- Create a Turso DB, then set env:
  - `DATABASE_URL=libsql://<db>.turso.io`
  - `TURSO_AUTH_TOKEN=<token>`
- Run the migration script once against the prod DB (creates all Latch **and**
  better-auth tables). With the prod `DATABASE_URL`/`TURSO_AUTH_TOKEN` in env:
  ```
  pnpm build && pnpm --filter latch-platform db:migrate
  ```
  (It's idempotent — safe to re-run. Tables also self-create lazily on first
  request, but running this up front avoids a cold-start race.)

## 2. Environment variables (Vercel → Settings → Environment Variables)

| Var | Notes |
| --- | --- |
| `DATABASE_URL`, `TURSO_AUTH_TOKEN` | hosted DB |
| `BETTER_AUTH_SECRET` | stable secret |
| `BETTER_AUTH_URL` | **the prod origin**, e.g. `https://app.example.com` |
| `LATCH_VAULT_KEY` | **must stay stable** — change it and every stored token becomes undecryptable |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | model providers |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google **login** client |
| `GOOGLE_CALENDAR_CLIENT_ID/SECRET` | (optional) Calendar MCP client |
| `RESEND_API_KEY`, `EMAIL_FROM` | password-reset mail (verified sender) |
| `CRON_SECRET` | set by Vercel Cron; `/api/cron` checks `Authorization: Bearer` |

Add the production **OAuth redirect URIs** in Google Cloud:
- `https://<domain>/api/auth/callback/google` (login)
- `https://<domain>/api/latch/connections/google_calendar/callback` (calendar)

## 3. Function duration + Fluid Compute

Agent turns stream and can be long (tools, subagents). In **Settings →
Functions**:
- Enable **Fluid Compute** (default on) — needed for extended duration + instance reuse.
- Set **Default Max Duration** high. Pro/Enterprise: **800s** (GA), or **1800s**
  (beta, Node 20/22/24, per-function). Turns within the limit finish inline;
  longer/crashed turns are resumed by the cron sweep (below).

## 4. Cron (schedules + durability sweep)

`vercel.json` points Vercel Cron at `/api/cron` every minute. That route:
- `runDue()` — fires due scheduled agents (min interval 1/min on Pro).
- `sweep()` — reaps lease-expired/crashed runs and **resumes** them.

The dev in-process 30s tick is skipped on Vercel (gated on the `VERCEL` env).
Consider raising `durability.leaseTtlMs` (currently 30s) toward ~90s so a turn
killed mid-run isn't reaped before the next cron tick.

## 5. Notes

- Client disconnects don't lose work: `consumeSseStream` drains the turn
  server-side and the "generating" indicator + cron sweep cover reloads.
- HTTP/1.1 may drop idle connections; turns stream progress so they rarely idle.
