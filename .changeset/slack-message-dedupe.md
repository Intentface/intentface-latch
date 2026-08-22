---
"@intentface/latch-channels": patch
---

Slack: dedupe on the message, not the delivery — a mention inside a DM ran the turn twice.

Slack delivers one message as several events with distinct `event_id`s: a mention **inside a DM**
arrives as both `app_mention` and `message.im`, and the dispatch gate accepts each. The existing
dedupe is keyed on `event_id` (Slack's retry identity), so it saw two different ids and let both
through — two turns milliseconds apart on one message, each a full billed model call. Observed in
production: overlapping runs 151 ms apart.

Turn-running paths now also claim `(channel, ts)` — the message's identity across every event shape
it arrives in — through the same atomic `seen()` store. Claimed only where a turn actually runs, so
an ignored event never consumes it.
