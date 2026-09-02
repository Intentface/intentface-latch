---
"@intentface/latch-core": minor
"@intentface/latch-server": minor
---

One cron entry point and one non-streaming turn path.

- `runtime.cron({ now?, maxAttempts? })` fires due schedules (`runDue`), then —
  with durability on — reaps lease-expired runs and resumes them (`sweep`).
  The phases are isolated: a failure in one lands in `errors` and the other
  still runs. Point every cron at this and nothing else. `tick()` is removed
  (it was `storage.reapExpiredRuns` behind a method); `runDue`, `sweep` and
  `resume` stay for callers that want the halves. `POST cron/run` on the
  handler now returns `cron()`'s result (`{ due, reaped, resumed, errors }`)
  instead of `runDue()`'s.
- `runAgent`, `spawn_agent` and scheduled fires now share one internal
  `runToCompletion` path (previously three near-copies), so approval
  semantics, telemetry linkage and the "did it park?" verdict can't drift.
  Behaviour is unchanged; `runAgent`'s result shape is unchanged.
- `runTurnStream` (the ephemeral, persist-nothing turn) is removed along with
  the `ephemeral` / `responseFormat: "text"` / `onComplete` branches inside the
  turn builder. Its only consumer was a smoke test. If you need a non-persisted
  turn, that belongs as an option on `handleChat`, not a second entry point.
- Every tool's `options.context` now also carries `runtime` (the `Runtime`
  itself), so harness tools can schedule, list chats or spawn runs without a
  host-global.
