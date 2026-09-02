---
"@intentface/latch-agent-builder": minor
---

`save_agent` no longer detaches state it doesn't manage: when the input omits
`tools` (per-tool selection, editor-managed) or `attachedEvals` (an evals
feature's rubrics), the existing record's values are carried over — pinned to
the record's own scope so a same-named agent in the other scope never donates
its state. `delete_agent`'s schedule cascade now runs regardless of the
`scheduling` option (schedules may come from other surfaces; an orphan errors
on every tick).
