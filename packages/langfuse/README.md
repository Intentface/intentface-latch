# @intentface/latch-langfuse

Langfuse observability for Latch. Implements `@intentface/latch-core`'s
dependency-free `telemetry` seam so any Latch host gets tracing, online evals,
and user feedback with one line — and exposes score/trace helpers platforms use
to read data back.

## Tracing

```ts
import { createRuntime } from "@intentface/latch-core";
import { langfuseTelemetry, isLangfuseConfigured } from "@intentface/latch-langfuse";

const runtime = createRuntime({
  // …storage, agents, etc…
  telemetry: isLangfuseConfigured()
    ? langfuseTelemetry({ ownerTag: (p) => ownerKey(p) })
    : undefined,
});
```

Every agent run becomes one Langfuse trace whose id is derived deterministically
from the run id (`traceIdForRun`), tagged `owner:` / `agent:` / `run:`, with
`sessionId` = the chat id and `userId` = `ownerTag(principal)`. Reads and scores
address a trace from the run id alone — no lookup.

Configuration is read from the environment by the Langfuse SDK:
`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` (defaults to
`https://cloud.langfuse.com`). With no keys, `isLangfuseConfigured()` is `false`
and the seam should be left `undefined` — zero behavior change.

## Scores

```ts
import { postScore } from "@intentface/latch-langfuse";

// judge verdict or user feedback on a run's trace
await postScore({ runId, name: "helpfulness", value: 1, comment, dataType: "BOOLEAN" });
```

## Reading traces (server-side, owner-scoped)

```ts
import { listOwnerTraces } from "@intentface/latch-langfuse";

// the tenant's recent traces + their scores, newest first
const traces = await listOwnerTraces({ ownerTag, agent, limit: 50 });
```

`ownerTag` is the tenancy boundary — the platform proxies all reads and filters
on it, so end users never receive Langfuse credentials.

## Public API

| Export | Purpose |
| --- | --- |
| `langfuseTelemetry(opts)` | The `LatchTelemetry` implementation for `RuntimeConfig.telemetry`. |
| `traceIdForRun(runId)` | Deterministic Langfuse trace id for a run. |
| `postScore(input)` | Attach a score (judge/feedback) to a run's trace. |
| `listOwnerTraces(args)` | Owner-scoped trace feed with scores joined in. |
| `isLangfuseConfigured()` | Whether the env credentials are present. |
| `getLangfuseClient()` | The shared `LangfuseClient`. |
| `ensureTracing()` / `flushLangfuse()` | OTEL provider setup + serverless flush. |
