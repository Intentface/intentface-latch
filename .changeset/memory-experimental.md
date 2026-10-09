---
"@intentface/latch-core": patch
"@intentface/latch-memory": patch
---

Memory is now marked **experimental**: the `memory` options on `createRuntime` and `defineAgent`, the `@intentface/latch-memory` package and its docs. The only production store today is a Loredex workspace, and the interface still carries Loredex conventions, so the design may change in any release. Nothing changes in behaviour.
