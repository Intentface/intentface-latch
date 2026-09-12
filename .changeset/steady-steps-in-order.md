---
"@intentface/latch-core": patch
---

Per-step checkpoints (durability on) now commit in step order, and the finish
handler's final write is the row's last write.

Each checkpoint replaces the in-progress assistant message wholesale. They were
fire-and-forget with nothing ordering them, so a slow early write could commit
after a later one and roll the stored message back to an older step — a crash
in that window re-ran a step that had already been persisted — and the final
step's checkpoint raced the finish handler for the same row, where a late
checkpoint clobbered the usage and cost metadata only the finish handler stamps.

Checkpoints are now chained: each write starts the moment the one before it
commits, and the finish handler awaits the chain before it settles the run row
and persists the final message. Recovery never revisits a completed run, so a
row that says `completed` now always sits next to a message that already holds
the final step — previously the last checkpoint could still be in flight at
that moment, and a crash there lost the answer text. The chain orders, it does not batch — a crash at step N still loses at
most the write in flight and the one queued behind it. A failed checkpoint logs
and releases the chain, as before.
