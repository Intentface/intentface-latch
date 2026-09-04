---
"@intentface/latch-channels": minor
---

Slack strict v1 — mention-only, channel-scoped. A channel turn now runs ONLY
from an `app_mention`: un-mentioned replies in a thread the bot owns are no
longer processed ("thread-follow" is gone), DMs are unchanged. History is read
at the mention and nowhere else: a top-level mention injects the last 20
channel messages before it, a mention in a thread injects the replies since the
chat's last-seen watermark (a fresh tail when there is none), always fenced as
untrusted third-party data with the bot's own messages dropped.
`SlackThreadStore` gains `markSeen`, `SlackChatMeta` gains `lastSeenTs`, and
`threadReplies` takes `{ limit, oldest, latest, inclusive }`. New: an `audit`
sink on the channel config (one event per admission decision and approval
click), `slackScopeGuard()` — a `ToolGuard` that pins every tool call of a
Slack-triggered tree to its channel — and a "_requested by @user_" footer on
channel answers. Messages from another workspace (Slack Connect) are dropped
before any identity lookup. `chat.postMessage` now defaults `unfurl_media` off
alongside `unfurl_links`.

Fix: the streaming renderer now stays in Slack's `chunks` mode for the whole
stream (text travels as a `markdown_text` chunk). Mixing a task card with a
top-level `markdown_text` append made Slack reject every later append with
`streaming_mode_mismatch`; the close failed, the answer arrived as a fallback
post, and the "Thinking" card spun forever. `LATCH_SLACK_STREAM_DEBUG=1` logs
every stream call for diagnosis.
