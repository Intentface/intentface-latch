# @intentface/latch-core

The framework core for building agents on the **AI SDK v7** — the runtime, the message/identity model, and the pluggable seams everything else plugs into. Dependency-light and host-agnostic (no HTTP framework, no DB, no provider SDKs).

## What it does

- **Runtime** (`createRuntime`) — the composition root + operations facade. Runs one agent turn with a `ToolLoopAgent`, streams UIMessage parts, persists messages/runs/usage, and handles:
  - **Approvals** (HITL): a turn pauses on a gated tool (`applyApproval` resumes it).
  - **Durability** (opt-in): run leases + heartbeats + a cron reaper (`tick`/`sweep`) re-drive interrupted runs.
  - **Subagents**: a `spawn_agent` tool that runs another agent in an isolated child run.
  - **Schedules**: cron/one-shot agent runs (`schedule`/`runDue`) via a pluggable cron seam.
- **Message model** — `AppMessage` = a typed AI SDK `UIMessage` with `metadata` (visibility, usage, cost, model). The source of truth; usage/cost incl. cached-prompt split live here.
- **Seams** (interfaces the platform fills): `StorageAdapter`, `ConnectionRegistry`, `Vault`, `Pricing`, the `cron`/`sandbox`/`harnessTools`/`resolveProviderTools` runtime hooks, and `Principal` (opaque identity — authz is the integrator's job).
- **Helpers** — `defineAgent`, `defineContext`, `mergeConnections`, `computeCost`/`staticPricing`, projections (`toModelMessages`/`toClientMessages`).

## Usage

```ts
import { createRuntime, defineAgent } from "@intentface/latch-core";

const runtime = createRuntime<Principal, Ctx>({
  storage, context, agents, connections,
  pricing, sandbox, harnessTools, cron, durability: { enabled: true },
});

const res = await runtime.handleChat({ agent: "assistant", principal, message });
```

## Where it fits

The base of the `@intentface/latch-*` stack. Mount it over HTTP with `@intentface/latch-server`; persist with `@intentface/latch-drizzle`; add tools via `@intentface/latch-mcp` / `@intentface/latch-openapi`; reach chat platforms with `@intentface/latch-channels`.
