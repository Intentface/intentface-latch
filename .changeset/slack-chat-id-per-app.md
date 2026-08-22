---
"@intentface/latch-channels": minor
---

Slack threads are scoped to the app that owns them.

`slackChatId` gains an app segment (`slack_<app>_<channel>_<root>`) and `slackChannel` a
`chatNamespace` option to supply it. Without it, every bot in a channel shared **one** Latch chat
per thread — because they all receive `message.channels` for the same message. Two consequences,
both observed in production: each bot's `isFollowedThread` saw the other bots' replies as its own
history, so a single un-mentioned follow-up was answered by **every** bot in the channel; and they
read and wrote one interleaved history, so an agent answered out of another agent's conversation.

`parseSlackChatId` still parses legacy unscoped ids (and now returns `app` when present), so
threads predating the fix keep resolving. Hosts should pass `chatNamespace` — new threads then get
their own chat per bot.
