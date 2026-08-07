# latch-platform

The reference **Latch platform** — a full app that wires the `@intentface/latch-*` packages into a multi-tenant product: build agents, connect tools, chat, schedule runs, and reach Slack. Built on **TanStack Start** (SSR, deployed on Vercel via Nitro), **better-auth** (Google + email, org/multi-tenant), and **Turso/libsql**.

## What it does

- **Composition root** (`src/lib/latch.ts`) — builds the runtime over Turso: storage + Vault, the connection registry (built-in MCP + user-added MCP/OpenAPI), agents (code-declared in `src/agents/` + UI-created), durability, cron, the sandbox + harness tools (`web_fetch`, …), provider-native web tools, **memory** (`@intentface/latch-memory`: Loredex store + provider into the runtime), and pricing (models.dev, cache-aware). Exposes one mounted handler at `/api/latch/*`.
- **UI** (`src/routes/`) — chats (per-chat + total cost), the agent editor (model, instructions, connections, per-tool enable/approval, subagents, sandbox/web tools, **memory** (scope + connection + live status panel), **Slack**), connections (MCP/OpenAPI + OAuth), runs (tokens/cached/cost), schedules (cron + timezone). Built on `@intentface/latch-ui`.
- **Memory jobs** (`src/lib/memory/`, `src/agents/memory-*.ts`) — the background sweep behind agent memory: extraction from idle chats and per-scope consolidation, run as internal `memory-extractor`/`memory-consolidator` agent runs (reserved `memory-*` prefix, hidden from pickers). This is the reference implementation of the wiring steps in `packages/memory/README.md`.
- **Identity** (`src/lib/auth.ts`, `session.ts`) — better-auth session → `Principal { orgId, userId }`; org switching, invites, members.
- **Slack** (`src/lib/slack-*.ts`, `routes/api/slack*`) — own-app-per-agent via `@intentface/latch-channels`: manifest/OAuth onboarding, linked-users gate, thread-following.
- **Ops** — `routes/api/cron.ts` (Vercel Cron → `runDue` + `sweep` + `memorySweep`), `scripts/migrate.ts` (`pnpm --filter latch-platform db:migrate`).

## Develop

```bash
pnpm install
pnpm --filter latch-platform dev   # vite dev on :3000
```

Env: `DATABASE_URL` + `TURSO_AUTH_TOKEN`, `BETTER_AUTH_SECRET`, `LATCH_VAULT_KEY`, model provider keys (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`), `RESEND_API_KEY` + `EMAIL_FROM`, Google OAuth, `CRON_SECRET`. See `DEPLOY.md` for the Vercel checklist.

## Where it fits

The "user-land" that consumes every package. It's also the productized reference for embedding Latch into a customer's stack — eject any default adapter behind the same seams.
