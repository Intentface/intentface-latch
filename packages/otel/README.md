# @intentface/latch-otel

Tracing for Latch over OpenTelemetry. Implements `@intentface/latch-core`'s
`telemetry` hook: each run is one trace, the AI SDK's model and tool spans nest
under it, and everything goes over OTLP to the backend you choose. A preset for
Langfuse is included.

```bash
pnpm add @intentface/latch-otel @ai-sdk/otel   # @ai-sdk/otel at the version matching your `ai`
```

## Langfuse

```ts
import { createRuntime } from "@intentface/latch-core";
import { otelTelemetry } from "@intentface/latch-otel";
import { isLangfuseConfigured, langfuse } from "@intentface/latch-otel/langfuse";

const runtime = createRuntime({
  // …storage, agents…
  telemetry: isLangfuseConfigured()
    ? otelTelemetry({ user: (p) => ownerKey(p), export: langfuse(), environment: "production" })
    : undefined,
});
```

`langfuse()` reads `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and
`LANGFUSE_BASE_URL` (default `https://cloud.langfuse.com`), and sends to the
project's OTLP endpoint. Each run shows as one trace named after the agent, in
the conversation's session, with the user, tags (`owner:`, `agent:`, `run:`,
`agent-version:`, `parent-run:`, `agent-owner:`) and run metadata. Under it:
the AI SDK's agent span, each step, each model call as a generation with its
messages and token usage, and each tool call with its arguments and result.

## Any other backend

```ts
telemetry: otelTelemetry({ user: (p) => ownerKey(p) }),
```

With no `export`, spans go over OTLP/HTTP to `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
or `OTEL_EXPORTER_OTLP_ENDPOINT`, with `OTEL_EXPORTER_OTLP_HEADERS`: Grafana,
Honeycomb, Datadog, Jaeger, a collector. Or pass any `SpanExporter`, or a
destination of your own (`{ exporter, runAttributes, finishedAttributes }`, the
shape `langfuse()` returns) to add the attributes your backend wants.

## What's on the spans

- The run's span, `latch.run <agent>`: the whole turn, saving it included.
  Its trace id is `traceIdForRun(runId)`, so anything that knows a run can link
  to its trace. When the run ends it gets `input.value`, `output.value`,
  `latch.run.status`, token usage and `latch.cost`, and an error status if the
  run failed.
- On every span of the run: `session.id` (the conversation; a subagent shares
  its parent's), `user.id`, `gen_ai.agent.name`, `latch.run.id`,
  `latch.chat.id`, `latch.agent.version`, `latch.parent_run.id`, `latch.depth`,
  `latch.trigger`, `deployment.environment.name`.
- The AI SDK's spans, in the GenAI semantic conventions, from `@ai-sdk/otel`
  (configure it with `aiSdk`).

It runs its own tracer provider and registers an async context manager only if
the app has none, so it doesn't take over tracing your app already does. On
serverless, pass `waitUntil` so the flush outlives the response.

Replaces `@intentface/latch-langfuse` (0.21 and earlier), whose trace ids it
keeps. Reading traces back and writing scores were left out: they belong to
your app or an evaluation tool.
