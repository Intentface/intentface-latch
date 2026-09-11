---
"@intentface/latch-core": patch
---

Two delegation paths had drifted from the rules the rest of the runtime applies.

A test run (`runAgent` / `test_agent`: autonomous with gated tools stubbed) that
delegated through `spawn_agent` handed the child only its approval mode, not
the stub flag — so a "side-effect-free" trial could delegate to an agent whose
gated tools ran for real. The child now inherits the parent's execution
restrictions as a set.

Resuming a subagent after a bubbled-up approval decision re-ran its model over
history whose last message was the paused assistant turn, without trimming the
trailing narration the other continuation paths (`applyApproval`,
`applyToolResult`, crash recovery) already strip. Providers that refuse an
assistant prefill rejected that request. The subagent resume now applies the
same trim.
