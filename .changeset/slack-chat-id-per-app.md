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

`parseSlackChatId` still parses legacy unscoped ids (and now returns `app` when present). For
threads that predate scoping, `slackChannel` also takes `resolveChatId({ scoped, legacy })`: a host
returns the legacy id when a chat exists there **and belongs to this agent**, and the scoped id
otherwise — so the bot that owns an existing thread keeps its history while the other bots that
were sharing that chat fall through to their own. Without the hook an existing thread would switch
to a scoped id and its history would go invisible (plain replies unfollowed, a later mention
starting an empty chat).

Hosts should pass `chatNamespace`, and `resolveChatId` if they have threads from before the fix.
