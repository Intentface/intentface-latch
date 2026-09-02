---
"@intentface/latch-core": minor
"@intentface/latch-drizzle": minor
"@intentface/latch-agent-builder": minor
---

Remove configuration the runtime never read. `RuntimeConfig.secrets` (the
vault resolver belongs on `createMcpConnections`, and tools resolve secrets
from `options.context.principal`), `RuntimeConfig.codeModeWrap` and
`AgentConfig.codeMode` (never executed), `ContextDefinition.toolsContext`
(the runtime already hands every tool `{ ...runtimeContext, principal, run,
writer }` as `options.context`), the deprecated `runtime` alias on the agent
factory argument (use `context`), and drizzle's unused `MessageStore`
override on `createSqliteAdapter`. Agent-builder's `model` factory receives
`{ context, principal }` instead of `{ runtime, principal }`.
