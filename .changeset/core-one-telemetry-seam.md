---
"@intentface/latch-core": minor
"@intentface/latch-server": minor
---

One observation seam, and a callback that always identifies itself.

- `RuntimeConfig.observability` (`onStep` / `onFinish` / `onError`) is folded
  into `LatchTelemetry`: `TelemetryRunMeta` gains `trigger` (what started the
  turn — `chat` / `decision` / `programmatic` / `schedule` / `resume`), and
  `LatchTelemetry` gains an optional `onStep(run, step)`. `onRunFinished`
  already covered `onFinish` and `onError` (status `"errored"` + the message).
  The two seams fired near-identical payloads at the same points; hosts now
  wire one object, and a tracer and plain callbacks compose instead of living
  in parallel. `TurnTrigger` moved to `telemetry.ts` (still exported from the
  package root).
- Handler: `stateParams` and the legacy no-pin callback fallback are removed,
  and `resolveContext` loses its `extra` argument. Every flow the handler
  starts pins the resolved principal into the state; a callback without a pin
  is now rejected as `flow_expired` instead of asking the live session to
  stand in — the exact failure that once stored an org's tokens under a
  personal owner.
- Fix: a turn whose model stream errored used to be settled as `completed`
  (the SDK still runs `onFinish` after `onError`) and reported to telemetry
  three times (`errored`, `errored`, `completed`). The first error now wins:
  one `errored` report, and the run row says `errored` with the message.
