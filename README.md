# Latch

**The reusable backend for building, persisting, and operating AI agents — built on [AI SDK v7](https://ai-sdk.dev), designed to embed in your stack and grow with you.**

Latch is the connective tissue you'd otherwise write by hand around the AI SDK: message persistence, multi-tenant context, tools & MCP, a credential vault, durability (resume-after-crash), scheduling, usage/cost tracking, and human-in-the-loop approvals — as **additive seams**, not an all-or-nothing framework.

It starts as thin ergonomics over the AI SDK (define an agent, stream it — runs on any serverless backend, zero infrastructure). When the product needs more, you turn on a database, then durability, then connections — **each step additive, never a rewrite or a data migration.** A weekend prototype and a multi-tenant production platform run the *same* core.

> Why it exists, in one line: stop rebuilding the same agent backend for every product. See [`PHILOSOPHY.md`](./PHILOSOPHY.md) for the *why* and [`PLAN.md`](./PLAN.md) for the *how*.

---

## Highlights

- **Define agents in a few lines** — `defineAgent` / `defineContext`: typed, lazy, engine-agnostic config over `ToolLoopAgent`. Your tenant shape flows into agents, tools, and hooks with no `any`.
- **Persistence built in** — `chats / messages / runs / usage` via a single `StorageAdapter` (Drizzle: **SQLite & Postgres** today, same contract). `AppMessage` *is* a typed `UIMessage`, so all the stock SDK stream/persistence helpers work unchanged.
- **Stream over HTTP or call the runtime directly** — one framework-agnostic handler you mount at a single route (TanStack/Next/Hono/serverless), or use the runtime from cron / your own routes / non-HTTP triggers.
- **Durability without a workflow engine** — opt-in lease + heartbeat + reaper + fencing + **resume** + per-step checkpointing. A turn that dies is reclaimed and re-run, exactly once across nodes, on plain TypeScript + your DB.
- **One cron entry point** — `runtime.cron()` fires due schedules and reaps-and-resumes stalled runs; drive it from an in-process interval loop *or* a serverless `POST /cron/run` route.
- **Tools + MCP host** — connect MCP servers as tools behind a **per-tenant SSRF allowlist** and **vault-brokered auth** (incl. **OAuth** — authorization-code + PKCE, tokens in the vault). Custom/stdio/in-memory transports supported.
- **Vault** — envelope-encrypted, per-tenant secret storage (Web Crypto, serverless-portable). Credentials never reach the model, logs, or telemetry.
- **HITL tool approvals** — gate sensitive tools; the turn pauses (`awaiting_input`), the decision round-trips as message state, then continues. No suspension machinery.
- **Custom data parts** — a `writer` for streaming structured/transient UI artifacts (status, citations, markers), available in the turn and to tools, with full user/run context.
- **Three views of a message** — what you *store*, what the *model* sees, what the *user* sees, governed by two axes (`visibility`, `sendToModel`). Internal context reaches the model without leaking to the user.
- **Usage & cost** — token usage and computed cost recorded on the message, the run, and a ledger, behind a pluggable `Pricing` seam.
- **BYO-auth, multi-tenant from day one** — a one-function `Principal` / `ContextResolver` seam; tenant isolation enforced at the storage layer (IDOR-proof by default).

---

## Adoption tiers (additive — no rewrites, no migrations)

| Tier | Install | Infra | What you get |
|---|---|---|---|
| **0 · Stateless** | `core` | none | `defineAgent` + context + tools + stock v7 streaming. The AI SDK with ergonomics. Any serverless backend. |
| **1 · Persistence** | `+ drizzle` + a DB | a database | Run-to-completion + persisted messages, conversation history, token/cost tracking. *No durability machinery.* |
| **2 · Durability** | `+ a cron reaper` | the DB + a cron | Resume-after-crash / long-running / background runs via lease + heartbeat + reaper + idempotency. |

MCP, vault, approvals, scheduling, and rate-limiting are independent opt-ins at any tier.

---

## Quick taste

```ts
import { defineAgent } from "@intentface/latch-core";
import { createSqliteAdapter, migrate, schema } from "@intentface/latch-drizzle";
import { createLatchHonoApp } from "@intentface/latch-server/hono";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { serve } from "@hono/node-server";

const client = createClient({ url: "file:./latch.db" });
await migrate(client);

const { app } = await createLatchHonoApp({
  storage: createSqliteAdapter(drizzle(client, { schema }), { owner: (p) => [p.orgId] }),
  // BYO auth: request → your Principal, null → 401. Replace the header lookup
  // with your session — trusting a caller-supplied header is for local demos only.
  resolveContext: async (req) => {
    const org = req.headers.get("x-org");
    return org ? { orgId: org } : null;
  },
  // Agents pick their model from the models.dev catalog (whatever you have keys for).
  agents: (models) => ({
    assistant: defineAgent({
      model: models.modelFor("claude-sonnet-4-6"),
      instructions: "You are a concise, helpful assistant.",
      defaultTools: true, // web_fetch, askUser, schedule tools
    }),
  }),
});
serve({ fetch: app.fetch, port: 8787 });
```

That's the whole backend: durability (resume-after-crash), an in-process cron (or `POST /cron/run` on serverless), pricing + reasoning + prompt-caching hooks from the catalog, the harness tools, and the HTTP surface. App-level options (`models`, `principalKey`, `cronIntervalMs`) sit on the config itself; every runtime and handler default is overridable via `runtime` / `handler`. Prefer to mount into your own framework? `const { handler, runtime, models, stop } = await createLatchApp({...})` gives you the bare Web `handler`; `createLatchHandler()` / `createRuntime()` are still there when you want to wire pieces yourself.

```bash
curl -N http://localhost:8787/agents/assistant/chat-1 \
  -H 'content-type: application/json' -H 'x-org: org_a' \
  -d '{"text":"In one sentence, what is Latch?"}'
```

A runnable, durable server with the reaper + MCP-OAuth routes lives in [`apps/example/src/serve.ts`](./apps/example/src/serve.ts).

---

## Use with your coding agent

Install the Latch skill so Claude Code, Cursor, Codex and other agents build with Latch the way it's meant to be used: recipes for the common tasks, the rules that break quietly, and the docs for your version.

```bash
npx skills add https://intentface-latch-docs.vercel.app
```

More in [Build with AI](https://intentface-latch-docs.vercel.app/docs/build-with-ai), including `llms.txt` and how to pin the skill to an older release.

## Core concepts

- **Runtime** — the composition root + operations facade. Wire your seams once (`createRuntime`); everything (routes, cron, tests) calls the runtime, never the seams directly. Stateless and serverless-safe — all per-run state lives in the DB. Operations: `handleChat`, `loadHistory`, `resume`, `sweep`, `tick`, `applyApproval`.
- **`AppMessage`** — the stored unit and source of truth: a typed `UIMessage<AppMetadata, …>`. Two axes on the metadata (`visibility`, `sendToModel`) drive the **client** and **model** projections (`toClientMessages` / `toModelMessages`). Execution facts (usage, cost, model, finishReason) ride in metadata — no separate "steps" table.
- **Seams** — `StorageAdapter`, durability engine, `Scheduler`, `Vault`/`SecretStore`, MCP host, `Pricing`, `ContextResolver`. Sensible defaults, swappable without touching agent code.
- **Durability** — the DB is the coordination point; offset-addressed, no instance affinity. Lease + heartbeat keep a run alive; a cron `tick()`/`sweep()` reclaims dead ones; fencing tokens stop a zombie worker from corrupting reassigned state.

---

## Packages

```
@intentface/latch-core           runtime, AppMessage + projections, durability, vault,
                                 scheduler, pricing, compaction, subagents, the seams.
                                 deps: zod (ai >= 7 is a peer)
                                 /models: models.dev catalog + provider hooks
                                 /harness: bash/read/write/glob/grep over the sandbox
                                 seam, web_fetch, askUser, schedule tools
@intentface/latch-drizzle        StorageAdapter + SecretStore + limit/memory/agent
                                 stores (SQLite & Postgres) + migrations
@intentface/latch-server         one mountable Web handler (chat, approvals, lists,
                                 schedules, connection OAuth, cron) — Hono in /hono
@intentface/latch-mcp            MCP host: SSRF allowlist, vault auth, OAuth + DCR
@intentface/latch-openapi        tools from an OpenAPI spec, same connection model
@intentface/latch-memory         agent memory: compiled index per turn, search/save
                                 tools, background extraction & consolidation
@intentface/latch-channels       Slack, Telegram, WhatsApp on one turn kernel
@intentface/latch-agent-builder  agent records as data + the builder agent
@intentface/latch-langfuse       tracing (Langfuse over OpenTelemetry)
@intentface/latch-net            SSRF-safe fetch for your own code
@intentface/latch-renderer       headless-browser fetch service (private, deployed
                                 not published)

apps/example                 runnable example + the smoke-test suite (not published)
```

Minimal install = **core + drizzle** (+ server if standalone). Everything else is opt-in. Packages publish to npm as `@intentface/latch-*`, every published package at the same version (`latch-renderer` is private and stays out). See [RELEASING.md](RELEASING.md).

---

## Status

**Working today** (exercised by 17 smoke suites, both SQLite & Postgres): agents & context, persistence, streaming + Hono routes, tools, MCP host + OAuth, vault, durability (lease/heartbeat/reaper/fencing/resume/checkpoint), scheduler, tool approvals, writer/data parts, message projections, usage & cost.

**Working today** also includes **memory** (`@intentface/latch-memory`): agents that declare `memory` get a compiled index injected per turn, `memory_search`/`memory_save` tools, and background extraction + consolidation via the cron sweep. Scopes: `agent-user` | `agent-org` | `user`. Caveat: on an org-shared connection, per-user separation is a folder convention — anyone with workspace access can read the `_memory/**` files.

**Also working:** subagents (`spawn_agent`, each in its own persisted thread; approvals surface to the parent), compaction (`runtime.compactChat`, projection-only — the record is never rewritten), a sandbox seam with the harness tools, code execution in a QuickJS engine, OpenAPI tools, per org/user/agent limits, agents as data, and the models.dev catalog for pricing, reasoning and prompt caching.

**Not built:** files & attachments as a seam (`FileStore`), MCP elicitation, a CLI, a reusable evals package (the platform app has an eval runner; nothing is published), and observability beyond the Langfuse/OpenTelemetry exporter. See [`PLAN.md`](./PLAN.md).

Pre-1.0 on purpose, on AI SDK v7 (`ai >= 7` as a peer). Public API may still move; releases are patch-level until it settles.

---

## Develop

```bash
pnpm install
pnpm build          # turbo: build all packages
pnpm typecheck      # turbo: typecheck all

# See features in action (in-memory, no API key — uses a mock model):
pnpm --filter @intentface/latch-example smoke              # T1 persistence
pnpm --filter @intentface/latch-example smoke:durability   # lease/heartbeat/reaper/fencing
pnpm --filter @intentface/latch-example smoke:resume       # crash → reclaim → resume
pnpm --filter @intentface/latch-example smoke:approval     # HITL gate → approve/deny
pnpm --filter @intentface/latch-example smoke:vault        # envelope-encrypted secrets
pnpm --filter @intentface/latch-example smoke:mcp-integration  # live MCP tool through the host
# …and more (tools, scheduler, oauth, writer, projections, cost)

# Real model server (needs apps/example/.env — see .env.example):
pnpm --filter @intentface/latch-example serve
```

Monorepo: pnpm + Turborepo. Dev uses a `development` export condition so editing a package's `src` is reflected without a rebuild.

---

## License

MIT.
