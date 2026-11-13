---
"@intentface/latch-core": patch
"@intentface/latch-server": patch
---

Live updates (experimental): a page that didn't start an answer can show it as it is written. A second tab, a page reloaded mid-answer, and the answer to a signal, a held message or a schedule.

- `liveStreams` on the runtime: where a running answer's stream is kept so another request can read it. `memoryLiveStreams()` for one long-running server. On serverless, a few lines over Redis pub/sub and the `resumable-stream` package; the guide has them. Without `liveStreams` nothing changes.
- `runtime.streamChat` and `GET chats/:chatId/stream`: the running answer from its start, as `useChat` reads it when it resumes. `204` when nothing is running.
- `runtime.watchChat` and `GET chats/:chatId/events`: server-sent events for a page watching a chat (`hello`, `started`, `ended`, `changed`), so it needs no poll loop. Needs the optional `notify` and `listen` on the store; `404` without them.
