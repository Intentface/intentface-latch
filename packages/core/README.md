# @intentface/latch-core

The framework core for building agents on the **AI SDK v7** — the runtime, the message/identity model, and the pluggable seams everything else plugs into. Dependency-light and host-agnostic (no HTTP framework, no DB, no provider SDKs).

📖 **Full documentation: [`apps/docs`](../../apps/docs)** — run `pnpm --filter @intentface/latch-docs dev` and open http://localhost:3100/docs.

## In one screen

```ts
import { createRuntime, defineAgent, defineContext } from "@intentface/latch-core";

const runtime = createRuntime<Principal, Ctx>({
  storage, // chats, messages, runs, usage, schedules
  context, // per-turn RuntimeContext built from the principal
  agents, // name → agent factory
  // …optional seams: pricing, connections, memory, cron, sandbox, telemetry
});

const response = await runtime.handleChat({ agent: "assistant", principal, message });
```

## What it does

- **Runtime** (`createRuntime`) — composition root + operations facade. Runs one agent turn with a `ToolLoopAgent`, streams `UIMessage` parts, persists messages/runs/usage, and handles approvals (HITL), durability (leases + reaper), subagents, and schedules.
- **Message model** — `AppMessage` = a typed AI SDK `UIMessage`. The source of truth; two axes (`visibility`, `sendToModel`) drive the client and model projections.
- **Seams** — `StorageAdapter`, `ConnectionRegistry`, `Vault`, `Pricing`, `MemoryProvider`, plus the `cron` / `sandbox` / `harnessTools` / `telemetry` hooks. `Principal` stays opaque: authz is the integrator's job.
- **Helpers** — `defineAgent`, `defineContext`, `mergeConnections`, `computeCost` / `staticPricing`, `toModelMessages` / `toClientMessages`.

## Docs map

| Page | Covers |
| --- | --- |
| Introduction | what it is, the adoption tiers, a minimal runtime |
| Runtime | every config field, every operation, what a turn does in order |
| Agents | `defineAgent`, capability flags, subagents, dynamic agents |
| Turn inputs | principal, context, messages, projections, compaction |
| Storage | the `StorageAdapter` contract and the guarantees it must make |
| Operations | durability, schedules, human-in-the-loop |
| Seams | connections, vault, memory, pricing, telemetry, sandbox |

Runnable examples live in [`apps/example`](../../apps/example) — 23 smoke scripts covering persistence, durability, resume, approvals, MCP, vault, cost and observability.

## Where it fits

The base of the `@intentface/latch-*` stack. Mount it over HTTP with `latch-server`; persist with `latch-drizzle`; add tools via `latch-mcp` / `latch-openapi`; reach chat platforms with `latch-channels`. Chat UI primitives live in a separate repo, [`@intentface/chat`](https://github.com/Intentface/intentface-chat).
