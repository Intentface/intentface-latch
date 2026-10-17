---
"@intentface/latch-otel": patch
---

Depend on `@opentelemetry/exporter-trace-otlp-http` 0.222 and `@opentelemetry/sdk-trace-base` / `context-async-hooks` 2.11. 0.22.0's exporter (0.217) pinned `protobufjs` 8.0.1 and `@opentelemetry/core` 2.7.1, both with published advisories (prototype pollution and denial of service in protobufjs; unbounded memory in core's baggage parsing); the newer exporter drops `protobufjs` and uses a patched core. Checked against Langfuse again: same traces.
