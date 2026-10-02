---
"@intentface/latch-core": patch
---

`memory: false` reaches delegated agents. A turn run with memory off (as evals run every input, so each is an independent observation) used to spawn subagents with memory back on: they recalled earlier inputs and could save new memory. `spawn_agent` now passes memory off down the tree, like it already does `blockGated`.
