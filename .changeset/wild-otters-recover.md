---
"@intentface/latch-core": patch
---

Crash recovery no longer re-runs a turn that had already finished.

Finishing the tool loop and recording that it finished are two separate writes:
the per-step checkpoint lands at each step's end, while the run row becomes
`completed` in the finish handler. A process that dies between them leaves a
finished turn on an `active` row, so the reaper picks up a run whose answer is
already in history.

`resume()` now reads the tail of that history first. A last step that called no
tool means the loop had stopped, so the row is reconciled (`completed`, or
`awaiting_input` when a gate is pending) without a model call — previously the
answer was generated a second time and, because the message id is reused,
appended to the message that already held the first one. A turn waiting on a
client-handled tool (`askUser`) is finished in the same sense: `onFinish`
records it as completed and the answer arrives through `applyToolResult`, so
recovery records the same instead of re-running and asking the question twice.

When work genuinely remains, the resumed history now also passes through
`trimTrailingAssistantPrefill`, which the two human-decision resume paths
already did and crash recovery never did. Without it a tail ending in the
turn's own half-written sentence reaches the model as an assistant prefill,
which models that refuse one reject on the request *shape* — so every identical
retry fails until `maxAttempts` is spent.

`trimTrailingAssistantPrefill` also gains an `unanchored` option (default off,
so the decision paths are unchanged) that trims a tail with no `tool-*` part to
anchor on. Crash recovery passes it as a guard: the one anchorless tail a
checkpoint can produce is a tool-free turn, which the classifier now settles
before the trim is reached.

Recovery also checks whether the chat moved on. Reaped runs are resumed one at a
time, and while one waits its chat is free — so a later message can start, and
even finish, a whole turn first. That is read off the runs table, never inferred
from message shapes: a user message is only ever persisted together with its
run, so a later run in the same chat is the one fact that proves a later turn
exists. Such a run settles as errored with the same outcome `openTurn` gives a
stale run, rather than being classified (or re-run) against a conversation that
moved on. Compaction runs are summaries, not turns, and do not count.

The runtime now also warns at startup when durability is enabled on a storage
adapter without `openTurn`: turn creation is then two writes, and a crash between
them is a shape recovery can only partly reason about. Every shipped adapter
implements it.

Also exports `resumeShapeOf` for hosts that drive recovery themselves.
