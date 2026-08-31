---
"@intentface/latch-channels": minor
---

Slack: never edit-to-mimic streaming. The fallback engine no longer fakes
streaming with `chat.update` edits — when native streaming is unavailable (or a
live stream idle-expires mid-turn) the turn buffers and the finished answer is
posted exactly once. A stream that dies mid-turn is now deleted (previously it
lingered as a stranded "⚠️ Thinking" message above the answer) and the engine
change is reported through `onStreamMode`, so binding health reflects the
engine that actually finished the turn. The `chat:write.customize` display
identity (`botName`/`iconEmoji` config, `identity` stream option) is removed —
every message now renders as the native bot, so streamed and fallback messages
share one avatar. `fallbackUpdateIntervalMs` is gone with the edit loop, and
the Slack client gains `deleteMessage` (`chat.delete`).
