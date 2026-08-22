---
"@intentface/latch-channels": minor
---

Slack: structural guards against a thread running away.

Observed in production: one thread produced **22 agent runs from ~3 real exchanges**, in bursts of
5–8 concurrent turns, with 44 Slack events — the bot answering its own posts. Three fixes, each
independently sufficient to have prevented it:

- **`botUserId` config** — the authoritative self-check. `bot_id`/`subtype` are absent on some post
  shapes, and a self-message that slips through the thread-following gate makes the bot answer
  itself and post again. Comparing `event.user` to the bot's own id can't miss. Omitted → previous
  `bot_id`/`subtype` behaviour.
- **`isBusy` config** — a circuit breaker checked before every inbound turn (mentions, DMs and
  thread-following alike): never stack turns on one chat. A feedback loop can outrun any single
  filter; this caps the blast radius to one turn. Omitted → no cap.
- **Interaction dedupe + ACK-first.** `block_actions` deliveries are retried by Slack exactly like
  events, and the resume one triggers is a full agent turn — they now go through the same atomic
  `seen()` dedupe (keyed on `trigger_id`), and tenant resolution moved *after* the ACK so a cold
  start can't blow Slack's 3s window and earn a retry in the first place.
