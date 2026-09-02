# @intentface/latch-agent-builder

## 0.9.0

### Minor Changes

- d96d6d8: `save_agent` no longer detaches state it doesn't manage: when the input omits
  `tools` (per-tool selection, editor-managed) or `attachedEvals` (an evals
  feature's rubrics), the existing record's values are carried over — pinned to
  the record's own scope so a same-named agent in the other scope never donates
  its state. `delete_agent`'s schedule cascade now runs regardless of the
  `scheduling` option (schedules may come from other surfaces; an orphan errors
  on every tick).
- 42768f6: One agent-record schema. `@intentface/latch-agent-builder` now exports
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
- 8745142: Remove configuration the runtime never read. `RuntimeConfig.secrets` (the
  vault resolver belongs on `createMcpConnections`, and tools resolve secrets
  from `options.context.principal`), `RuntimeConfig.codeModeWrap` and
  `AgentConfig.codeMode` (never executed), `ContextDefinition.toolsContext`
  (the runtime already hands every tool `{ ...runtimeContext, principal, run,
  writer }` as `options.context`), and the deprecated `runtime` alias on the
  agent factory argument (use `context`). Agent-builder's `model` factory
  receives `{ context, principal }` instead of `{ runtime, principal }`.
  
  Drizzle: the unused message-persistence override is gone — the `messages`
  option on both `createSqliteAdapter` and `createPostgresAdapter`, and the
  `MessageStore` type export from the package barrel.

### Patch Changes

- Updated dependencies [ebc0afd]
- Updated dependencies [d062dd2]
- Updated dependencies [8745142]
- Updated dependencies [cbbd775]
- Updated dependencies [78a40e3]
- Updated dependencies [7d3c553]
- Updated dependencies [b22b3cf]
  - @intentface/latch-core@0.9.0

## 0.8.1

### Patch Changes

- Updated dependencies [e0e2000]
  - @intentface/latch-core@0.8.1

## 0.8.0

### Patch Changes

- Updated dependencies [c5a64fd]
  - @intentface/latch-core@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [fcef9d2]
- Updated dependencies [fcef9d2]
  - @intentface/latch-core@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [3721c48]
- Updated dependencies [8b9e1c8]
  - @intentface/latch-core@0.6.0

## 0.5.0

### Patch Changes

- @intentface/latch-core@0.5.0

## 0.4.1

### Patch Changes

- @intentface/latch-core@0.4.1

## 0.4.0

### Patch Changes

- @intentface/latch-core@0.4.0

## 0.3.1

### Patch Changes

- @intentface/latch-core@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [ddfa57b]
  - @intentface/latch-core@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [194c789]
- Updated dependencies [c782ec9]
  - @intentface/latch-core@0.2.0

## 0.1.0

### Patch Changes

- b00e813: Publish internal `@intentface/latch-*` dependencies as caret ranges instead of exact pins.
  
  These packages previously declared each other at an exact version, so installing two of
  them at different patch levels put a second copy of the shared package in `node_modules` —
  its own module registry, its own `instanceof` identities, and no error to say so. They now
  declare `^<version>`, which dedupes against the range in your own `package.json`.
  
  Nothing to do on your side beyond installing; a fresh install collapses any duplicate that
  an earlier version produced.
- Updated dependencies [166c7a8]
  - @intentface/latch-core@0.1.0

## 0.0.1

### Patch Changes

- Updated dependencies [9dd4f7a]
  - @intentface/latch-core@0.0.1
