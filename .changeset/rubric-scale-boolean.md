---
"@intentface/latch-agent-builder": patch
---

A rubric's `scale` now also accepts `"boolean"`, the spelling the AI SDK's
evaluation contract uses. `"binary"` means exactly the same thing and remains
valid; new clients should write `"boolean"`.

The DEFAULT deliberately stays `"binary"`. This schema is published, and a host
that branches on `scale === "binary"` would silently take its graded path for
every rubric that omitted the field if the default moved — a breaking change
wearing a rename's clothes. Accepting a synonym costs nothing; changing what
absence means does not.

Hosts reading the field should test for the one spelling that means graded
(`scale === "score"`) rather than for `"binary"`, so the synonym cannot flip a
0/1 verdict into a 0–1 score.
