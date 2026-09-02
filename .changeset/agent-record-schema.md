---
"@intentface/latch-agent-builder": minor
"@intentface/latch-drizzle": minor
---

One agent-record schema. `@intentface/latch-agent-builder` now exports
`AgentRecordSchema` (zod, also on the browser-safe `./record` subpath) plus
`normalizeAgentRecord` / `parseAgentRecord` / `parseAgentRef`; the `AgentRecord`
type is inferred from it. The record gains `exec.memory` (core `MemoryConfig`)
and `attachedEvals`; the never-executed `exec.codeMode` is gone. The builder's
`save_agent` takes the record itself (the `capabilities` → `exec` remap and the
top-level `authoredTools`/`effort` fields are gone — write `exec.*`), so the
model, an editor, and a host validator all speak one shape. `CapabilitySupport`
adds `renderTools` and opt-in `memory`. `AgentBuilderExtension.validateSave`
now receives `(principal, record)`; `SaveAgentInput` is removed.
`AgentBuilderStore` adds `getRecord(p, name)` (pin-aware) and
`listMemoryEnabledNames()`.

Drizzle: `latch_agents` gains an `attached_evals` column (idempotent ALTER; DBs
written by latch-platform already have it) and the agent store round-trips
`attachedEvals`, resolves `exec.memory`, and implements the two new store
methods. `byOwners` filters by name at the query.
