# @intentface/latch-otel

## 0.23.0

### Patch Changes

- Updated dependencies [2fdf606]
  - @intentface/latch-core@0.23.0

## 0.22.1

### Patch Changes

- 31c0ee1: Depend on `@opentelemetry/exporter-trace-otlp-http` 0.222 and `@opentelemetry/sdk-trace-base` / `context-async-hooks` 2.11. 0.22.0's exporter (0.217) pinned `protobufjs` 8.0.1 and `@opentelemetry/core` 2.7.1, both with published advisories (prototype pollution and denial of service in protobufjs; unbounded memory in core's baggage parsing); the newer exporter drops `protobufjs` and uses a patched core. Checked against Langfuse again: same traces.
- Updated dependencies [a672cee]
  - @intentface/latch-core@0.22.1

## 0.22.0

### Minor Changes

- 6fd0423: New `@intentface/latch-otel`: tracing over OpenTelemetry, to any backend, replacing `@intentface/latch-langfuse`.
  
  - `otelTelemetry({ user, export, environment, agentOwner, attributes, aiSdk, waitUntil })` implements core's `telemetry` hook. Each run is one trace with the id `traceIdForRun(runId)` (the same id latch-langfuse derived), rooted in a `latch.run <agent>` span; the AI SDK's spans from `@ai-sdk/otel` (agent, steps, model calls with messages and usage, tool calls) nest under it. Every span carries `session.id`, `user.id` and the run's `latch.*` attributes. The run's span gets the input, output, status, usage and cost when the run ends.
  - Spans go over OTLP/HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT` by default, or to any `SpanExporter`. `langfuse()` from `@intentface/latch-otel/langfuse` sends to Langfuse's OTLP endpoint with the trace name, session, user, tags (`owner:`, `agent:`, `run:`, `agent-version:`, `parent-run:`, `agent-owner:`), metadata and environment Langfuse shows; checked against a Langfuse project.
  - It runs its own tracer provider, so it doesn't replace one the app registered. `@ai-sdk/otel` is a peer dependency: install it at the version matching your `ai`.
  - `@intentface/latch-langfuse` is no longer released. Its trace reading (`listOwnerTraces`, `listAdministeredTraces`) and score writing (`postScore`, `scoreIdForRun`) aren't carried over; an app that needs them keeps its own copy.

### Patch Changes

- Updated dependencies [6fd0423]
  - @intentface/latch-core@0.22.0
