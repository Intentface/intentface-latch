---
"@intentface/latch-core": minor
---

Observability events now carry `trigger` — what started the turn, and so whether anyone is watching it: `"chat"` (a user message), `"decision"` (a human answered an approval or a client-handled tool), `"programmatic"` (a direct `runAgent` call — no client stream, so `runAgent` takes a `trigger` for hosts that know a person is waiting), `"schedule"` (a cron/one-shot fire), `"resume"` (the durability sweep recovering a crashed run). A subagent turn inherits its parent's trigger, like `rootChatId`.

This is what makes `observability.onFinish` usable as an operational notification channel rather than only an analytics feed: it already carries `principal`, `chatId`, `runId`, `agent`, `status` and `cost`, but `status: "awaiting_input"` was indistinguishable between a scheduled fire nobody can answer and a gate rendering in front of a live user. Now `status === "awaiting_input" && (trigger === "schedule" || trigger === "resume")` is exactly "go tell this turn's owner". Documented in the Observability and Schedules seams, with a push example — no new seam, and no second overlapping way to learn the same fact.

Relatedly, `runSchedule` may now return `{ handled, chatId?, parked? }` instead of a bare boolean. A host that takes over delivery owns the chat its fire ran in, so only it can report that chat (which the next occurrence's `onParked` check reads) and whether the fire parked (which joins `runDue`'s `parked` count). A bare `true`/`false` behaves exactly as before.
