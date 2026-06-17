# Latch — Philosophy & Core Idea

> The *why*. For the *how*, see [`PLAN.md`](./PLAN.md).

## The problem
Every time we build an agent product for a customer, we rebuild the same backend from scratch: message persistence, tool-loop agents, per-tenant context and workspaces, MCP wiring, usage/cost tracking, rate limiting, durability so a run survives a crash. It's the same plumbing every time, re-implemented slightly differently, and the interesting product work waits behind it.

## Who it's for (and where it came from)
Latch grew out of consulting work — building AI features for SaaS companies. The recurring pattern: reimplementing the same agent backend every time, often inside a stack we didn't choose. That's *why* Latch is **embed-or-standalone** and **zero-lock-in**: it should drop in alongside any backend — called as a service, or embedded directly if you're on Node — deliver most of what an agent product needs out of the box, and never trap you. The interesting work is your domain and your users; the plumbing shouldn't be rebuilt from scratch each time.

## The idea
**Latch is the reusable backend for building, persisting, and operating agents — built on AI SDK v7, designed to grow with you.**

It starts as a thin layer of ergonomics over the AI SDK (define an agent, stream it, done — runs in any serverless backend with zero infrastructure). When you need more, you add message persistence, then cost tracking, then durability, then workspaces, MCP, scheduling — **each as an additive step, never a rewrite.** A weekend prototype and a multi-tenant production platform run the *same* core; the difference is which seams you've plugged in.

## Principles

1. **Progressive, not all-or-nothing.** Tier 0 is basically the AI SDK with nicer ergonomics and zero infra. Tier 1 adds a database. Tier 2 adds durability. You only pay for what you turn on, and moving up a tier never forces a rewrite or a data migration. Start tiny; grow when the product demands it.

2. **Pluggable everything, zero lock-in.** Storage, durability (event store / executor / transport), auth, model providers, file storage, workspaces, scheduling — all seams with sensible defaults. The default bundle needs no external infrastructure; swap any piece (Postgres→Mongo, inline→Inngest, S3→R2, DB-tail→Durable Streams) without touching agent code.

3. **Bring your own everything.** We never own your stack. Embed Latch behind *your* auth, in *your* existing Hono or Express backend and *your* database — or run it standalone. Auth in particular is a one-function seam (`Principal`/`ContextResolver`), because every customer authenticates differently.

4. **The log is the source of truth.** Runs are an append-only event log; messages, status, usage, and resumability are projections of it. Durability and observability fall out of this one decision instead of being bolted on. State is `fold(log)`.

5. **Three views of a message, never conflated.** What you *store* (`AppMessage`), what the *model* sees (`ModelMessage`), and what the *user* sees are distinct projections, governed by two axes — `visibility` and `sendToModel`. Internal context (compaction summaries, injected instructions) reaches the model without leaking to the user; the user sees a clean conversation.

6. **Stay on the SDK's grain.** We build *on* AI SDK v7 primitives (`ToolLoopAgent`, `UIMessage`, `runtimeContext`, the stream helpers) — we don't fork them. Our additions are typed sugar and pluggable seams, so you keep the full SDK underneath and we keep up with it for free.

7. **Composability over features.** New capabilities should assemble from a few core seams — event log, run executor, `prepareStep`, hooks, scheduler, context — not bespoke subsystems. Subagents, steering, compaction, and even self-evolving prompts are *compositions* of these, not new machinery. If a feature needs a new primitive, question it.

8. **Type-safety end to end.** Context, tools, and messages are typed per project. The types we export are the contract a UI (or any consumer) builds against — `defineContext` makes your tenant shape flow into agents, tools, hooks, and `prepareStep` with no `any`.

9. **Multi-tenancy is not an afterthought.** Org / user / session scoping is carried by context and enforced at the storage and workspace layers from day one — because retrofitting isolation is how you get incidents.

## What it is / isn't (today)
- **Is**: a backend framework + adapters for agent products. Backend-first, with exported types so UIs (incl. our own chat components, later) plug in cleanly.
- **Isn't (yet)**: a hosted platform. And never: an opinionated auth system, a model gateway you must route through, or a replacement for the AI SDK. It's the connective tissue around the SDK that you'd otherwise write by hand.

## Future direction: framework → platform
A hosted platform is a natural later layer, **not a pivot** — and the design is built for it. The framework comes first (and stays open / embeddable), which is the adoption on-ramp; the platform is the same pluggable core with **managed default adapters** (managed event log, executor/queue, file storage, workspaces, MCP gateway) plus a **control plane** (the usage/cost, rate-limit, admin-event, and agent/schedule management we're already building as adapters) and a multi-tenant dashboard + billing.

Two commitments make this an open-core model, not lock-in:
- The same core runs **self-hosted** with zero proprietary pieces — customers can always eject.
- "Hosted" only ever means *we operate the adapters for you*; it never changes the contracts.

The progressive tiers (stateless → persistence → durability) map naturally to a pricing ladder, so adoption and monetization share one architecture.

## Inspirations (and where we differ)
- **AI SDK v7** — our foundation; we extend, never fork.
- **Pi** (earendil-works) — typed message entries, extension hooks, compaction, steering/queue. We borrow the *ideas* and map them to AI SDK primitives.
- **Flue** — "the log is the source of truth," shadcn-style codegen, zero lock-in. We share the philosophy; we're embed-first and AI SDK-native rather than runtime-first.
- **Durable Streams / models.dev** — good ideas and data we *use as optional adapters*, never as required foundations.

## The north star
When a decision is unclear, prefer the option that:
1. lets a customer start smaller and grow without a rewrite,
2. keeps a piece swappable instead of baked in,
3. stays on AI SDK primitives,
4. composes from existing seams rather than adding new ones.

Make the simple case trivial and the hard case possible.
