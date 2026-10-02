---
"@intentface/latch-core": minor
"@intentface/latch-agent-builder": minor
"@intentface/latch-drizzle": minor
---

Safe-mode runs stop stubbing tools the agent explicitly waived, and gain three
per-turn levers for measurement. Agent references can pin a version.

**Fix — a waived tool is not a gated one.** `blockGated` decided what to stub
with a truthiness check. The SDK spells a waiver as the string
`"not-applicable"` — and the drizzle store writes exactly that for every tool
an agent sets to `false` — so every tool an agent had explicitly waived was
stubbed in every safe-mode run. On an agent whose reads are waived to override
a connection default, that is every read tool: the agent could not reach its
own corpus, and an evaluation graded a model with no access to its tools.
`gatedBy` now treats only `true`, `"user-approval"`, an object or a function
as a gate.

**Upgrading — waived tools now run in safe-mode runs.** A tool whose approval
the agent turned off (`false`, `"not-applicable"`) was stubbed in every
`runAgent` test run; it now executes, exactly as it does in a normal turn.
Gated tools are still stubbed. If a test run relied on a waived tool that
writes never being called, gate that tool or keep the run out of production
data.

**`blockGated: "simulate-success"`** stubs gated tools with a success-shaped
result instead of a "blocked" one. A blocked result makes the agent narrate
the failure into its answer ("I couldn't record this internally"), which then
lands in the text being graded.

**`memory: false`** on `runAgent` disables recall and memory tools for one
turn. A sweep over many inputs under one principal otherwise has row 1's
memory in context by row 20 — the rows stop being independent observations.

**`model`** on `runAgent` overrides the agent's model for one turn; the
telemetry model id follows it.

**`parseAgentRef` reads `name@7` and `name@draft`**, and `resolve()` honours
the pin read-only. Measuring an old version must never make it live; without
this the only way to run v3 was to publish it.

Platform (unpublished): a local SQLite file now runs WAL with a 10s busy
timeout. `busy_timeout = 0` made a second writer fail instantly rather than
wait, and a durable runtime writes a checkpoint per step — four agents in
parallel lost checkpoints, which is not a crash but a silently truncated
transcript.
