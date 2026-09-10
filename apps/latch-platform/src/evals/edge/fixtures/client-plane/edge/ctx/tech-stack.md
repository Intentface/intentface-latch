# TwentyOne — Tech stack

## What they own vs rent

The compressed read. Four questions, because the answers separate "ships AI features" from
"owns agentic capability":

- **Harness** — *partial.* The agent loop is their own code, but it is thin: a prompt, a
tool list, and a bounded step budget, executed as a workflow step. There is no separate
agent runtime, no sub-agents, no dynamic tool loading. It runs on the general-purpose job
queue rather than on anything purpose-built for agent execution.
- **Context** — *rented, effectively.* What goes into the prompt is assembled ad hoc per
agent step from the workflow's record context plus the user's custom prompt. There is no
context strategy, no compaction, no reusable context units.
- **Traces** — **Not discussed.** Whether anything is captured about agent runs — inputs,
tool calls, failures — did not come up. No trace or run-history surface exists in the
product, but whether telemetry exists internally is unknown.
- **Data flywheel** — **Not discussed.** Whether agent usage feeds anything back into
improving the feature was not established.

## Application stack

- **Backend:** TypeScript on NestJS. GraphQL as the primary API, REST alongside it.
- **Frontend:** React, with Jotai for state and a CSS-in-JS setup. i18n throughout.
- **Data:** PostgreSQL as the system of record. Per-workspace schema isolation for
multi-tenancy. Redis for caching and session state.
- **Jobs:** BullMQ over Redis. This is what workflows and agent steps actually run on —
it gives retries and scheduling, but not durable resumable execution: a job that dies
mid-run restarts from the beginning rather than resuming.
- **Repo:** Nx monorepo, packages split by domain.

## Deployment

Managed cloud on their own infrastructure, plus a documented self-host path (Docker
Compose for small deployments, Helm chart for Kubernetes). Self-hosters run the same
images. Cloud is single-region.

## Multi-tenancy

Workspace-level isolation enforced at the schema layer, with role-based access control on
top. This is the most mature part of the stack — it predates the AI work by years and is
load-bearing for the whole product. Agent steps execute inside the same tenancy boundary
as the workflow owner.

## LLM integration

A single provider, called directly through the vendor SDK from the agent-step executor.
Model choice is a deployment-level configuration value, not a per-agent or per-workspace
setting. No routing, no fallback, no provider abstraction layer — swapping providers would
be a code change.

## Testing and quality

Unit and integration tests on the core application, run in CI on every PR. End-to-end
tests cover the main CRM flows.

For the AI features specifically: **no eval infrastructure.** Agent step quality is
assessed by hand when something is reported as wrong. There is no regression suite for
prompts, no offline eval set, and no way to tell whether a prompt change made things
better or worse other than shipping it.

## Observability

Standard application monitoring — error tracking, APM, log aggregation. Whether agent runs
are represented in any of it is the open question noted above.
