# Latch — Agent Backend Framework (Plan)

Reusable backend for building/persisting/operating agents, so customer projects stop rebuilding this each time. Built on **AI SDK v7** (`ai@7.0.0-beta.178`, `ToolLoopAgent`). Embed into a customer's existing Hono/Express backend **or** run standalone. Platform-agnostic core. Backend-only + exported types. npm scope: **`@intentface/latch-*`**.

> Verified against bundled v7 docs/`.d.ts`. Anything marked **(ours)** is framework code, not an SDK API.

---

## Foundations — reuse the engines, build the layer
Verified (Jun 2026): the agent ecosystem's engines are Apache-2.0 and usable standalone. **We reuse them; we build only the multi-agent + multi-tenant + BYO-DB layer on top.** Eve (`eve` npm, Apache-2.0) is a *reference implementation* of one assembly of these — single-agent, single-identity, world-owned state — **not a dependency**.

| Reuse (don't rebuild) | For |
|---|---|
| `ai@7` (`ToolLoopAgent`) | the agent loop (**all tiers**), streaming, UIMessage |
| `@ai-sdk/sandbox-*` | sandboxes |
| `@ai-sdk/mcp` | MCP |
| `chat` (4.x) | channels (Slack/Discord/etc.) when needed |
| **zod v4** | schemas (AI SDK v7 + ecosystem are on zod 4, not 3) |
| `@ai-sdk/workflow` (`WorkflowAgent`) — **opt-in heavy tier only** | hardened durable execution when a client needs strict exactly-once **and** can run a worker; **not the default** |

**Build (our IP):** multi-agent registry · multi-tenant `defineContext` · tenant-aware scheduling fan-out · **our own lean session-replay durability** (lease+heartbeat+reaper+idempotency, plain TS + the *client's* Postgres) · embed-into-any-backend.

**When to use Eve instead of Latch:** greenfield, standalone, single-agent app (esp. Next.js/Vercel). **Use Latch when:** embed into an existing app · multi-tenant · multi-agent · data must live in the client's own DB. (Whole stack is pre-1.0 beta either way — unavoidable on `ai@7`/`@workflow@5`.)

## Stack & decisions (settled)
- Monorepo: **pnpm + Turborepo**. Lib builds tsup/tsc.
- Core **platform-agnostic**; Node + Vercel entrypoints now, Cloudflare later. HTTP via **Hono** (web-standard → embeds anywhere).
- Agent primitive: **`ToolLoopAgent`**. Tenancy/workspace isolation via **`runtimeContext` + `toolsContext` + per-tool `contextSchema`**.
- Persistence: **Drizzle** (Postgres + SQLite now; mysql/mssql via dialect, mongo via separate adapter later).
- Durability: **tiered, default is ours** — T1 = run-to-completion + persist (no machinery); T2 = **our own session-replay** (lease+heartbeat+reaper+idempotency, plain TS+Postgres); `WorkflowAgent`/`@workflow/world-postgres` only as an opt-in **hardened-exactly-once** path behind the seam. Serverless via **stateless offset reads + cron reaper** (DB is the coordination point — no instance affinity).
- Auth: **bring-your-own** — `Principal` + `ContextResolver` seam **(ours)**. Adapters: apiKey, jwt/OIDC, betterAuth, passthrough.
- Models: **own `createProviderRegistry` + `customProvider` aliases**; **models.dev** for catalog/pricing.
- Messages: **`AppMessage`** = typed `UIMessage` **(ours)**, two axes (`visibility`, `sendToModel`); two projections.
- Context-extensions (compaction etc.): **`ContextExtension` registry (ours)**; compaction = first built-in. Inspired by Pi (earendil-works/pi).
- Streaming: **stock v7 helpers** (`createUIMessageStream`/`toUIMessageStream`/`createUIMessageStreamResponse`, `messageMetadata`, `generateMessageId`, `consumeStream`). Model projection in `prepareStep`.
- Workspaces: **`WorkspaceProvider` (ours)** → AI SDK `experimental_sandbox` contract. Daytona first real impl (per-tenant creds), swappable.
- MCP: **`@ai-sdk/mcp` `createMCPClient`** (HTTP/SSE/stdio, OAuth). Full session/notifications via official MCP SDK later.
- Memory: **`MemoryProvider` seam (ours)** — custom-tool-over-StorageAdapter default (+ optional pgvector); Anthropic memory tool / Mem0 / Letta / Supermemory adapters. Distinct from history/compaction/prompt-evolution.
- Files: **`FileStore` seam (ours)**, S3-compatible default; references on `FileUIPart` (no base64 in DB).
- Scheduling: **`Scheduler` seam (ours)**, DB schedules + tick endpoint default; BullMQ/Inngest/Temporal swap-in.
- Docs: **`@hono/zod-openapi` + Scalar** for the API; **TypeDoc + MDX (`apps/docs`)** for SDK/guides.

---

## Packages (lean — split only by real dep/optionality)
```
@intentface/latch-core         whole framework. deps: ai, zod (light).
    = runtime (defineAgent/defineContext), AppMessage + projections,
      ContextExtension registry + compaction, run orchestration,
      session-replay durability (lease/heartbeat/reaper) behind a seam, StorageAdapter iface,
      model registry + aliases, usage/cost calc, rate-limit iface,
      observability hooks, Principal/auth seam, web-standard HTTP handlers.

@intentface/latch-server       Hono app + auth adapters + Express bridge.   deps: hono
@intentface/latch-drizzle      StorageAdapter (chats/messages/runs/usage) + migrations (pg/sqlite). deps: drizzle

— optional, pulled only if used —
@intentface/latch-mcp          MCP manager.                       deps: @ai-sdk/mcp
@intentface/latch-workspaces   WorkspaceProvider + daytona/local. deps: daytona sdk
@intentface/latch-cli          init / add / dev codegen. bin: `latch`

— future —
@intentface/latch-react        chat-UI components (exists in another repo; bring here later). consumes exported AppMessage/UIMessage types + data-* parts.

apps/
  example/   example + dev harness (not published)
  docs/      docs site: MDX guides + embedded TypeDoc reference (not published)
```
Minimal install = **core + drizzle** (+ server if standalone). Everything else opt-in.

### Adoption tiers (additive — no rewrites, no data migrations)
| Tier | Install | Infra | Get |
|---|---|---|---|
| 0 Stateless | core | none | defineAgent + context + tools + stock v7 streaming. ~AI SDK with ergonomics. Any serverless backend. |
| 1 Persistence (default) | + drizzle + Postgres | a DB | run-to-completion in one invocation + persist messages. Conversation, token/cost, history. **No durability machinery.** |
| 2 Durability | + cron reaper (our session-replay) | the DB + a cron | resume-after-crash / long-running / background via lease+heartbeat+reaper+idempotency, plain TS+Postgres. (Strict exactly-once → `WorkflowAgent`+worker behind the seam.) |
| 2a Resumable streams | + chunk buffer (Postgres or Redis) | optional | reconnect/replay token stream across tabs/devices via externalized **offset** buffer (not in-memory/affinity). |

No migrations because 0→1 has no prior data, and 1→2 (resume) is forward-looking: just start tracking run leases; old chats simply aren't resumable. MCP / workspaces / rate-limiting / scheduling are independent opt-ins at any tier ≥ their needs.
Scoped packages publish public via `"publishConfig": { "access": "public" }`. CLI bin = `latch`.

`agents/` is the **customer's** code (file-based `defineAgent`), not our package.

---

## Core concepts

### Agents — file-based + lazy factory (ours)
`agents/support.ts` default-exports `defineAgent((c) => config)`; filename = id. Factory resolved **per request** with `c.runtime` (typed) + workspace injected. DB-driven configs = optional later source. Serverless: **build-time manifest** (codegen) since no runtime fs.

### Context — defineContext (ours; sugar over native params)
v7 only has raw per-call `runtimeContext`/`toolsContext` (+ tool `contextSchema`). `defineContext` lets a project declare the **typed shape once**, **build** it per request from `Principal`, and **resolve `toolsContext`** (secrets). Type flows into `defineAgent`/`prepareStep`/hooks/tools. Compiles to stock `agent.stream({ runtimeContext, toolsContext })`.
```
ContextResolver(req) → Principal → context.build(Principal) → RuntimeContext
                                  → context.toolsContext(runtime, secrets) → per-tool context
```

### Messages — three levels
- **`AppMessage`** = `UIMessage<AppMetadata, AppDataParts, Tools>` — **the stored unit** (`messages` table). `AppMetadata` carries `visibility: user|internal|redacted` + `sendToModel?`.
- **`ModelMessage[]`** = `toModelMessages(app)` — filter `sendToModel`, fold compaction, prune. Ephemeral.
- **client `UIMessage[]`** = `toClientMessages(app)` — filter `visibility:user`, strip internal. Used on history load; live stream shaped by `writer.write`/`messageMetadata`.

### Context-extensions — open registry (ours)
Compaction is one plugin, not special-cased. `defineContextExtension({ kind, dataPart?, event?, defaults, toModel?, toClient?, trigger?, run? })`. Projections iterate the registry. Built-ins: compaction (+ branch-summary). Compaction summary lives in **log + `compactions` projection** (server-only); client gets a **marker** `data-compaction` part (no summary) unless `visibility` flipped.

### Auth — Principal / ContextResolver seam (ours)
Core never authenticates. `ContextResolver(req) => Principal`. Embed (Hono `app.route` + 1-line resolveContext, or Express `toExpress` bridge) or standalone (shipped adapter). Same handlers either way.

### Models
`createProviderRegistry({ anthropic, openai, gateway,... })` + `customProvider` logical aliases (`reasoning-medium`, `fast`). models.dev `api.json` → cached `CatalogStore` (DB snapshot) for pricing/cost + capability gating. Alias→models.dev id map for pricing.

### Workspaces
`WorkspaceProvider` → `experimental_sandbox` contract, injected per call. Scope (`shared|org|user|session`) resolved from RuntimeContext. DB stores only a **handle**; files live in provider. Daytona (persisted fs, per-tenant creds) + local; swappable.

### Subagents (AI SDK-native; near-term)
A subagent = a tool whose `execute` calls another `ToolLoopAgent` — isolated fresh context window (offloading, parallel research, tool-access isolation). `toModelOutput` controls what the main model sees (summary) vs the user (full sub-run) → **reuses our `visibility`/`sendToModel` axes**. Streaming via preliminary tool results (`async function*` + `readUIMessageStream`). We add: `asTool(agent, { toModelOutput })` helper; subagent runs = **child runs** in the log (`parent_run_id`); parent runtime/tools context propagates. Caveats: no tool approvals inside subagents; pass `abortSignal`.

### Steering / input queue (later; composes from executor + prepareStep + log)
Inject user input into an in-flight run. Per-run **input queue** owned by `RunExecutor`, DB-backed + pluggable (survives serverless processes). Modes (Pi): `steer` (drained between steps, before next LLM call), `followUp` (drained at run end → new run), `nextTurn` (stored for next prompt), + interrupt/abort. Emits `queue_update` events.

### MCP
`createMCPClient` per-tenant registry; OAuth `authProvider` + `validateAuthorizationServerURL` (SSRF guard); aggregate `.tools()` into agent; route elicitation to approval flow. AI SDK client is lightweight (no session/notifications) → upgrade specific connections to official MCP SDK later.

### Memory — `MemoryProvider` seam (ours)
Persistent recall **across** conversations/sessions — distinct from history (messages/log), compaction (within-convo, a ContextExtension), and self-evolving prompts (offline instruction tuning). Exposed to the agent as tools (add/search/recall), wired via context. Scope mirrors workspaces (`shared|org|user|agent`) resolved from RuntimeContext. AI SDK v7 offers three approaches; we wrap them behind one seam:
- **Custom tool over our StorageAdapter** (default) — a scoped `memories` table; full control, no extra infra. Optional **pgvector** (Postgres) for semantic recall via AI SDK `embed` (a `VectorStore` sub-seam; default keyword, swap to vector/external).
- **Provider-defined tool** — e.g. Anthropic memory tool (`anthropic.tools.memory_20250818`), `execute` → our storage backend.
- **External providers** — Mem0 / Letta / Supermemory / Hindsight as optional adapters.
Persistence tier. Complements self-evolving agents (both read history; memory = model-controlled recall, evolution = offline prompt tuning).

---

## Data model (DB, prefixed `latch_*`)
**v1 (LOCKED) — four tables; `messages` is the source of truth:**
- `chats` — thread `(id, org_id, user_id, agent, title, created_at, updated_at)`
- `messages` — **`AppMessage` rows = the durable conversation AND the source of truth.** `(id, chat_id, run_id, seq, role, parts jsonb, metadata jsonb, created_at)`. Content in `parts`; **usage/cost/model/finishReason in `metadata`**. Persisted incrementally per step. **No separate steps table; no token deltas stored** (deltas stream live, never persisted).
- `runs` — per-turn execution record `(id, chat_id, agent, status: active|awaiting_input|completed|errored, lease_owner, lease_expires_at, usage_totals, error, started_at, ended_at)`. Status + resume anchor + home for background/scheduled runs.
- `usage` — billing/quota ledger `(id, org_id, user_id?, run_id, model, input_tokens, output_tokens, cost, created_at)`. Fast aggregation (also derivable from message metadata).

Reconnect/observe = **stateless offset reads** over these tables → serverless-native, **no instance affinity** (the DB is the coordination point).

**Deferred / opt-in (add with their feature — forward-only, no migration):**
- `tool_results` — `(run_id, tool_call_id, output)` idempotency memo for T2 resume.
- `stream_chunks` — transient batched segments for T2a resumable streaming (deleted on settle).
- `run_events` — offset-addressed event log for deep observability/audit/replay + DS-protocol reactive stream. **Boundary events only, never tokens.**
- `compactions`, `memories`, `schedules`, `mcp_servers`, `workspaces`, `api_keys` — with their features.

Tenant isolation: app-level `org_id` scoping in StorageAdapter for v1 (Postgres RLS later). Framework owns `latch_*` tables + Drizzle migrations. **One `StorageAdapter` contract** (no SQL-only tier; Mongo first-class), schema-versioned.

---

## Durability — tiered; default is our own session-replay (ours)
We do **not** put a workflow engine on the critical path by default. The agent loop's state *is* the message array, so durability = checkpoint messages + resume by reloading them.

- **T1 (default):** the agent runs to completion in **one invocation** (`waitUntil` finishes it past client disconnect); persist messages at step boundaries. If it dies, you re-run on the next request. **No leases, no engine.** Covers most embed/SaaS cases.
- **T2 (opt-in — our session-replay, no black box):**
  - `runs.lease_owner`/`lease_expires_at` = **single-writer lease**, renewed by a **heartbeat timer** (~every 10s for a 30s TTL — decoupled from step duration so long steps don't drop it; the heartbeat also verifies ownership and aborts if lost).
  - **checkpoint messages per step** (in a transaction) → completed steps are durable.
  - **idempotency** via `tool_results(run_id, tool_call_id)` → a re-run step never re-fires a completed tool.
  - a **cron reaper** finds `status=running AND lease_expires_at < now()` and re-drives `driveRun(runId)` → continues from the last checkpoint.
  - Serverless: the loop runs in one invocation; if killed at the duration limit, the reaper resumes on a fresh invocation. Reads/reconnect = stateless offset queries (any instance). **No instance affinity** (DB is the coordination point — our platform-agnostic answer vs Flue's Cloudflare-DO).
  - Strict exactly-once (the brief two-owner window) → add **fencing tokens** (lease epoch; reject stale writes) when a client needs it.
- **Heavy/hardened opt-in (behind the seam):** `WorkflowAgent` (`@ai-sdk/workflow`) + `@workflow/world-postgres` for battle-tested durable execution — but it brings a **durable queue + leases + LISTEN/NOTIFY** (chattier writes, wants a **worker**, less serverless-native) and an **opaque engine schema** (not your queryable tables). Use only when a client genuinely needs its hardened guarantees and can run a worker.

Validated against **Flue's** shipped source (session-replay in your own DB: `flue_session_entries` + `flue_event_stream_entries` + `flue_agent_turn_journals`/`stream_chunks`). We follow that model, **platform-agnostic via Postgres offsets** instead of its Cloudflare Durable Objects. **Not** Eve's opaque world-delegation; **not** Electric's separate stream server.

---

## Multi-node exactly-once (ours) — atomic DB claims, no lock service
Every "pick up work" op is an **atomic conditional claim** against the shared DB → Postgres serializes it → exactly one winner, any node count. No separate coordinator/lock service — Postgres row atomicity *is* the coordination primitive.
- **Dispatch (one run per scheduled occurrence):** claim due schedules via `SELECT … FOR UPDATE SKIP LOCKED` (or `UPDATE … WHERE next_run_at <= now() RETURNING` that advances the clock) **+** create the run under a **UNIQUE `(schedule_id, scheduled_for)`** key → even a race can't create two runs.
- **Execution (one driver per run):** the run lease (`UPDATE … WHERE lease free/expired RETURNING`) + heartbeat; the reaper reclaims via the same atomic claim (two reapers → one wins).
- **Side-effects once:** tool idempotency by `tool_call_id` (+ **fencing tokens** for the brief two-owner window when strict exactly-once is required).

The DB is the coordination point → multi-node-safe with **no extra infra**.

## Engine portability — keep-the-door-open invariants
So `WorkflowAgent` (or any engine) stays a drop-in later, never violate these:
- **`defineAgent` returns config, never an instantiated engine.** The executor builds `ToolLoopAgent` / `WorkflowAgent` from the same options (both share the constructor shape).
- **Durability is an executor seam** with a stable contract: `run(agentConfig, input) → UIMessage stream + persist to messages`. Our session-replay is impl #1; `WorkflowAgent` is a later impl. Never bake an engine into app/route code.
- **HTTP/route boundary = "produce a UIMessage stream"** — so WorkflowAgent's `start() → run.readable → createModelCallToUIChunkTransform()` slots in next to ToolLoopAgent's direct stream.
- **Tools are plain `tool()`** — transform/serialization-friendly, no engine-specific assumptions.
- **`runs.lease_owner`/`lease_expires_at` are nullable** — workflow-backed runs leave them null (the world owns leases); only our session-replay uses them.

Result: adopting `WorkflowAgent` = add an executor impl + the build transform for that tier — **additive, not a rewrite.**

## Request lifecycle (one turn)
1. Auth → `Principal`; `context.build` → RuntimeContext; load `messages` (+ `validateUIMessages`) → `convertToModelMessages`.
2. Insert the user `AppMessage`; create `run` (`active`).
3. `createAgentUIStreamResponse({ agent, uiMessages, runtimeContext, toolsContext, prepareStep, messageMetadata, onStepEnd, onFinish })`. `prepareStep` applies ContextExtension model projections (compaction fold).
4. Stream to client (SSE). **`onStepEnd`** → step facts (usage/finishReason) → `runs`/`usage` + message metadata. **`onFinish`** → finalized `AppMessage[]` → `messages`. `consumeStream`/`waitUntil` for disconnect safety.
5. **T2 only:** heartbeat the run lease while looping; checkpoint messages per step; dedupe tools by `tool_call_id`.
6. **Crash/resume (T2):** cron reaper finds the interrupted `run` (expired lease) → re-drives → reloads `messages` → continues from the last checkpointed step (idempotent). Reconnect = offset read, any instance.

---

## Build phases
1. Scaffold monorepo + `latch-core` skeleton (`ToolLoopAgent` + `StorageAdapter` seam) + `latch-drizzle` (`chats/messages/runs/usage` schema, pg+sqlite) + a T1 `/chat` slice. Pin `ai@7.0.0-beta.178`, **zod 4**.
2. `runtime` (defineAgent/defineContext/projections) + example agent + `latch-server` Hono `/chat` route (stream + AppMessage persist + consumeStream) + Express bridge.
3. ContextExtension registry + compaction built-in.
4. Usage/cost + rate-limit middleware. OpenAPI (`@hono/zod-openapi`) + Scalar `/docs`.
5. Files/attachments (`FileStore` S3 + presigned upload). `FileUIPart` projections.
6. T2 durability (our session-replay: lease/heartbeat/cron reaper/idempotency) + HITL approvals; T2a resumable streams (externalized chunk buffer).
7. Scheduled/triggered runs (`Scheduler` seam + DB schedules + tick endpoint).
8. `latch-mcp` (HTTP/OAuth).
9. Memory (`MemoryProvider`: custom-tool default + optional pgvector; Anthropic-memory-tool adapter). `latch-workspaces` (local → Daytona).
10. Observability (OTel + event sink). `latch-cli` (`init`/`add`/`dev`) + `apps/docs` (MDX + TypeDoc) throughout.

---

## Files & attachments — `FileStore` seam (ours)
No base64 in the DB. AI SDK's `FileUIPart` natively takes `url` + caches `providerReference`:
```ts
{ type:'file'; mediaType; filename?; url; providerReference?; providerMetadata? }
```
- **AI SDK gives**: `FileUIPart.url` (http, not data-url) + `uploadFile()→ProviderReference` (upload to model provider once, cache on the part).
- **Ours**: durable blob storage via `FileStore` seam — **S3-compatible default** (AWS/R2/MinIO/B2), client injected (no hard dep); local-disk for dev.
```ts
interface FileStore { put; signedUrl(key,ttl); getStream; delete }
```
Flow: presigned **PUT direct to S3** (no proxying bytes) → `AppMessage` stores `FileUIPart` **reference only** (tenant-scoped key `org/{orgId}/chat/{chatId}/{uuid}/{file}`) → `toModelMessages` passes URL / streams bytes / uploads to provider (cache `providerReference`) per provider capability → `toClientMessages` resolves a short-TTL **signed URL**. Persist a stable ref (gateway URL or key), sign on read. Security: content-type/size limits, signed URLs, SSRF care. Interface + S3 impl live in `latch-core`. Persistence tier.

## Scheduled / triggered runs — `Scheduler` seam (ours)
**End users create schedules at runtime, so schedules are DATA (DB rows), not crontabs.** A scheduled run = a run kicked off by a timer instead of a user message → same execution + persistence path, run **as the owning user**.

- **Schedules = DB rows (the customer's Postgres), CRUD'd by end users via API:**
  `latch_schedules (id, org_id, user_id, agent, input, cron_expr | run_at, timezone, principal, enabled, overlap_policy: skip|queue|allow, next_run_at, last_run_at)`. Creating a "scheduled agent" = inserting a row.
- **Key column = `next_run_at`** — precomputed from the cron expr (DST-aware via `timezone`, e.g. `cron-parser`). The dispatcher query is a cheap indexed `WHERE enabled AND next_run_at <= now()`; it does **not** evaluate every cron each tick. Robust to downtime: overdue rows just fire on the next tick (catch-up).
- **One coarse tick = the dispatcher, and it's the SAME cron as the T2 reaper.** A single periodic job (`POST /internal/scheduler/tick`, hit by Vercel Cron / crontab / GH Action / a worker loop) both: (a) **starts due schedules** + recomputes `next_run_at`, and (b) **re-drives interrupted runs** (expired leases). One static cron drives N dynamic user schedules — no per-user crontabs.
- **Identity / multi-tenant safety:** each row stores the owning user's `principal` → `context.build({ principal })` → the run executes **as that user, with their permissions** (not elevated). Validate users can only schedule agents/inputs within their scope; rate-limit schedules per user/org.
- **Idempotency / overlap (multi-node):** claim due rows atomically (`FOR UPDATE SKIP LOCKED`) + a UNIQUE `(schedule_id, scheduled_for)` run key → **exactly one run per occurrence across nodes** (see *Multi-node exactly-once*); per-schedule `skip|queue|allow`.
- **Pluggable driver:** default = DB rows + tick endpoint (zero infra, all platforms). Swap → BullMQ repeatable / AWS EventBridge Scheduler / Temporal cron / QStash / Inngest at higher scale or sub-minute precision.
- Non-interactive (no client stream); results land in `runs`/`messages`, optional completion webhook. **Persistence tier; durable scheduled runs use T2** (background/long → want the reaper). This is the standard "schedules-as-data + one dispatcher" pattern (Zapier/GH-Actions-style), not per-user cron.

## Documentation
- **Server API** → **`@hono/zod-openapi`** generates OpenAPI 3.1 from our zod schemas (`/openapi.json`, no drift) + **Scalar** (`@scalar/hono-api-reference`) interactive UI at `/docs`. In `latch-server`; embed users get exported schemas to compose their own. REST surface only (chats, agents, runs, events, stop, approvals, file presign).
- **Streaming protocol** (SSE/UI-message chunks, resume offsets) → hand-written MDX guide (OpenAPI can't express it).
- **SDK/packages** → TSDoc + **TypeDoc** reference; **MDX guides site** (`apps/docs`, Fumadocs or Mintlify): quickstart (tiers 0→2), defineAgent/defineContext, three message levels + ContextExtensions, durability seams, auth/embed recipes (Hono & Express), files, scheduling, MCP, workspaces.
- Optional: generate typed clients for other languages from the spec (`@hey-api/openapi-ts`). Doc-as-you-build each phase. Pin `@hono/zod-openapi`/Scalar/Fumadocs vs current zod at scaffold.

## Future / backlog (add when needed — most reuse existing seams)
- **Subagents** — `asTool` helper + child runs (near-term; see above).
- **Steering / input queue** — steer/followUp/nextTurn + interrupt (see above).
- **Slash commands** — input-handling hook on the extension layer + input queue.
- **History browsing** — API/UI over `messages`/`run_events` (data already there).
- **Self-evolving agents** — scheduled job reads run history + **steering frequency** (signal that a prompt is off) → generates an instruction overlay stored **per-org/per-user** → injected via `defineContext`/before-agent-start hook. Composes from event-log + Scheduler + context-injection + a per-scope prompt store; no new primitives. Complements (not same as) Memory: evolution tunes *instructions*, memory recalls *facts*.
- **Evals (early + first-class, à la Eve)** — thin `defineEval` (cases: input + assertions) → run a `defineAgent` headlessly → score with deterministic assertions + LLM-as-judge → reporter. Runs in CI/dev, **reuses the headless agent runtime** (cheap to add). Or integrate **Braintrust/Evalite/promptfoo** (Braintrust overlaps the observability adapter — one integration, evals + tracing). Bonuses: seed eval datasets from production `messages` history; **evals are the metric the self-evolving-prompts feature needs.** A consultancy differentiator ("we prove it works and keep it working").
- **Richer extension hooks** (à la Pi: before_provider_request, etc.) as the hook layer matures.

## Resolved opens (recommended defaults — override if needed)
1. **Schema ownership** → own prefixed `latch_*` tables + ship Drizzle migrations; app-level orgId scoping v1, RLS later.
2. **MCP depth** → AI SDK client (tools+resources+OAuth) for v1; official MCP SDK wrapper for full session/notifications later.
3. **Daytona tenancy** → per-customer creds via SecretResolver; shared account as a config option.
4. **Executor for v1** → ship `RunExecutor` seam + `inline` only; `queueWorker`/durable adapter next.
