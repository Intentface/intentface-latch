---
"@intentface/latch-agent-builder": minor
"@intentface/latch-langfuse": patch
---

Rubrics gain a third scale, `"choice"`: the judge picks one of several named
options instead of answering yes or no.

It exists because a boolean records several different bugs as the same zero.
"Did it handle the ambiguity?" collapses asking-too-much, guessing silently and
refusing outright into one failed score — three behaviours with three different
fixes, and the score cannot say which one happened. As a choice it is one
question with `options` (name → meaning) and `bad` naming only the failures.

A choice is stored as its label PLUS the pass/fail projection every other scale
produces, so an aggregate over a choice rubric still means a pass rate and no
chart needs a special case.

`@intentface/latch-langfuse`: `postScore` accepts a string `value`, which is
what a `CATEGORICAL` score needs — the value IS the label, and a numeric
projection of it would throw away the thing the score exists to record.
