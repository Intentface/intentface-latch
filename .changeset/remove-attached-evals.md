---
"@intentface/latch-agent-builder": minor
"@intentface/latch-drizzle": minor
---

Evals are no longer part of Latch; the improvement loop handles them on its own.

- agent-builder: `AttachedEvalSchema`, the `AttachedEval` type and the agent record's `attachedEvals` field are removed. The record schema is strict, so a writer still sending `attachedEvals` is refused rather than silently losing it. `save_agent` no longer carries it over.
- drizzle: the agent store stops reading and writing the `attached_evals` column. The column stays in existing databases (and in the migrations, which an older version backfill reads), unused. Versions, drafts and candidates saved before still carry the field in their JSON; it's dropped when they're read, so an unchanged agent doesn't publish a new version and an old version restores through the strict schema.
