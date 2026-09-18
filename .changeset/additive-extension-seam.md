---
"@intentface/latch-core": patch
---

A new seam: `extensions`, on `RuntimeConfig` (every turn) and `AgentConfig`
(that agent's turns). An extension attaches handlers to the moments of a turn —
`before_agent_start`, `input`, `register_tools`, `tool_call`, `tool_result`,
`instructions`, `context`, `step_start`, `step_end`, `render`, `error`,
`agent_end` — and returns effects; the runtime composes any number of them with
one merge rule per moment. `defineExtension`, `compose`, `renderTranscript` and
the moment types are exported.

Omitted, nothing changes: with no extension attached a turn's provider requests,
UI chunks and stored record are byte-identical to before, which a snapshot
oracle now holds the runtime to.

Two behaviours are new only when an extension uses them. A `step_end` handler
runs before the next model call, so an extension that persists has written
before the model is asked again; and a handler on an extension marked
`critical` that throws fails the run (an ordinary one is reported and skipped).
