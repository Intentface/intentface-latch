# Latch — Agent Backend Framework (Plan)

Reusable backend for building/persisting/operating agents, so customer projects stop rebuilding this each time. Built on **AI SDK v7** (`ai@7.0.0-beta.178`, `ToolLoopAgent`). Embed into a customer's existing Hono/Express backend **or** run standalone. Platform-agnostic core. Backend-only + exported types. npm scope: **`@intentface/latch-*`**.

> Verified against bundled v7 docs/`.d.ts`. Anything marked **(ours)** is framework code, not an SDK API.

---

## Stack & decisions (settled)
- Monorepo: **pnpm + Turborepo**. Lib builds tsup/tsc.
- Core **platform-agnostic**; Node + Vercel entrypoints now, Cloudflare later. HTTP via **Hono** (web-standard → embeds anywhere).
- Agent primitive: **`ToolLoopAgent`**. Tenancy/workspace isolation via **`runtimeContext` + `toolsContext` + per-tool `contextSchema`**.
- Persistence: **Drizzle** (Postgres + SQLite now; mysql/mssql via dialect, mongo via separate adapter later).
- Durability: **append-only event log = recoverable spine**, projections on top. **Pluggable** (3 seams). All-DB + inline default = zero infra.
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
      durability SEAMS + inline/DB defaults, StorageAdapter iface,
      model registry + aliases, usage/cost calc, rate-limit iface,
      observability hooks, Principal/auth seam, web-standard HTTP handlers.

@intentface/latch-server       Hono app + auth adapters + Express bridge.   deps: hono
@intentface/latch-drizzle      StorageAdapter + EventStore + schema + migrations (pg/sqlite). deps: drizzle

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
| 1 Persistence | + drizzle + Postgres | a DB | AppMessage persistence, token + cost tracking, history, file attachments, schedules. |
| 2 Durability | + executor/transport (Redis/Inngest/Durable Streams) | a bit more | resume after death, human-resume, long-running/background/scheduled runs, HITL approvals. |

No migrations because 0→1 has no prior data, and 1→2 (resume) is forward-looking: just start writing `run_events`; old chats simply aren't resumable. MCP / workspaces / rate-limiting / scheduling are independent opt-ins at any tier ≥ their needs.
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
- `chats` — thread (orgId, userId, agent, title)
- `messages` — `AppMessage` rows: `(id, chat_id, run_id, seq, role, parts jsonb, metadata jsonb, created_at)` — materialized conversation
- `runs` — `(id, chat_id, agent, status: active|awaiting_input|completed|errored, usage, error)` — projection
- `run_events` — `(run_id, offset, type, payload, ts)` append-only — **recoverable spine + transport**
- `compactions` — `(chat_id, at_offset, first_kept_offset, summary, tokens_before, details)` — fast model-projection read
- `usage` / `cost` — tokens + $ per run/step × models.dev pricing
- `memories` — scoped recall `(id, scope, scope_id, key, content, embedding?, created_at)` — optional pgvector
- `mcp_servers`, `workspaces` (handle), `api_keys` (standalone only)

Tenant isolation: app-level `orgId` scoping in StorageAdapter for v1 (Postgres RLS later). Framework owns `latch_*` tables + ships Drizzle migrations.

---

## Durability — pluggable trio (ours)
```ts
durability: {
  events:    drizzleEventStore(db),   // append/read/tail — default DB
  executor:  inlineExecutor(),        // run + resume     — default in-request; swap queueWorker/inngest/temporal
  transport: dbTailTransport(),       // live reconnect   — default DB-tail; swap resumable-stream+Redis / Durable Streams
}
```
- Agent/tool/route code written only against seams.
- Default = all-DB + inline → zero infra; resume/history correct on default.
- "No durability" (ephemeral + null store) is a valid plug.
- **RunExecutor** is the keystone for long-running / resume-after-crash / HITL-approval (run `awaiting_input`, resume from log later).

---

## Request lifecycle (one turn)
1. Auth → `Principal`; `context.build` → RuntimeContext; load `messages`, `validateUIMessages`.
2. Create `run` (active); append `run_start`.
3. `agent.stream({ messages: toModelMessages(app), runtimeContext, toolsContext, prepareStep })`. Lifecycle callbacks → append events; `prepareStep` applies ContextExtension model projections (compaction fold).
4. Stream out via `createUIMessageStream` + `writer.merge(toUIMessageStream(...))`; markers via `writer.write`; `messageMetadata` carries AppMetadata; server ids via `generateMessageId`.
5. `onFinish` → persist AppMessage(s) + usage/cost; append `step_end`/`run_end`. `consumeStream()` for disconnect safety.
6. Crash/resume → fold `run_events` to last `step_end` → rebuild messages → executor re-drives loop.

---

## Build phases
1. Scaffold monorepo + `latch-core` skeleton + `latch-drizzle` event-log schema/StorageAdapter + durability seams (DB+inline). Pin `ai@beta`.
2. `runtime` (defineAgent/defineContext/projections) + example agent + `latch-server` Hono `/chat` route (stream + AppMessage persist + consumeStream) + Express bridge.
3. ContextExtension registry + compaction built-in.
4. Usage/cost + rate-limit middleware. OpenAPI (`@hono/zod-openapi`) + Scalar `/docs`.
5. Files/attachments (`FileStore` S3 + presigned upload). `FileUIPart` projections.
6. Durability upgrades behind seams (queue/Durable-Streams transport); HITL approvals + resume.
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
A scheduled run = a run kicked off by a timer → same `RunExecutor` + event-log path. Split timing from definition:
- **Schedule store (DB)**: `latch_schedules (id, org_id, agent, input, cron|run_at, principal, enabled, overlap_policy: skip|queue|allow, next_run_at, last_run_at)`.
- **Scheduler driver (pluggable)**: default = **DB schedules + tick endpoint** (`POST /internal/scheduler/tick`) any cron calls (Vercel Cron / CF Trigger / crontab / GH Action / curl) → enqueues due runs via `RunExecutor`. Zero special infra, all platforms. Swap → BullMQ repeatable / Inngest cron / Temporal schedules (own their clock).
- **Identity**: schedule stores owning/service `principal`; context via same `context.build({ principal })` (non-HTTP path).
- **Idempotency**: dedupe by `(scheduleId, scheduledFor)` run key (at-least-once safe).
- Non-interactive (no client stream); results in `run_events`/`runs`, optional completion webhook. Interface + store + tick in core/server; heavy drivers optional (reuse executor infra). Persistence tier; benefits from durability.

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
- **Richer extension hooks** (à la Pi: before_provider_request, etc.) as the hook layer matures.

## Resolved opens (recommended defaults — override if needed)
1. **Schema ownership** → own prefixed `latch_*` tables + ship Drizzle migrations; app-level orgId scoping v1, RLS later.
2. **MCP depth** → AI SDK client (tools+resources+OAuth) for v1; official MCP SDK wrapper for full session/notifications later.
3. **Daytona tenancy** → per-customer creds via SecretResolver; shared account as a config option.
4. **Executor for v1** → ship `RunExecutor` seam + `inline` only; `queueWorker`/durable adapter next.
