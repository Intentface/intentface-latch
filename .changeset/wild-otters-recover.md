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
appended to the message that already held the first one.

When work genuinely remains, the resumed history now also passes through
`trimTrailingAssistantPrefill`, which the two human-decision resume paths
already did. New `unanchored` option, used only by crash recovery, covers the
tool-free shape (`[step-start, text]`) that has no tool part to anchor on and
would otherwise reach the model as an assistant prefill — a hard rejection on
models that refuse one, and one that fails every identical retry until
`maxAttempts` is spent.

Also exports `resumeShapeOf` for hosts that drive recovery themselves.
