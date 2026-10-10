---
"@intentface/latch-core": patch
---

The doc comments on `createRuntime`'s options, the runtime's methods, `defineAgent`, `defineContext` and usage limits now explain each option for someone using it: what it does, what happens without it, and its default. They show in your editor and in the new generated reference on the docs site.

The inputs of `runAgent`, `applyApproval`, `applyToolResult` and `schedule` are now exported as named types (`RunAgentInput`, `RunAgentResult`, `ApplyApprovalInput`, `ApplyToolResultInput`, `ScheduleInput`), for typing your own wrappers. Nothing else changes.
