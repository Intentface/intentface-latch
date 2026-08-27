---
"@intentface/latch-core": minor
"@intentface/latch-drizzle": minor
---

Schedules get a parked-predecessor policy. When a scheduled fire's previous chat is still waiting on a human (an undecided approval or question), firing again just mints another parked chat and pays for the tokens up to the gate — on every tick, forever. `runDue` now checks the last fire's chat (the message-log fold, same predicates the interactive paths trust) and, under the default `onParked: "skip"`, consumes the occurrence without running; `onParked: "fire"` opts a schedule back into the old always-fire behavior. `runDue` returns a new `skipped` counter so quiet ticks stay legible. Storage: `ScheduleRecord.onParked` + `lastChatId`, and an OPTIONAL `noteScheduleFire` adapter method (drizzle implements it on both dialects with idempotent column migrations; custom adapters that skip it keep the old behavior).
