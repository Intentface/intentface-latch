---
"@intentface/latch-core": minor
"@intentface/latch-drizzle": minor
"@intentface/latch-server": minor
---

Stop a running answer: `runtime.stopRun({ principal, chatId })`, and `POST chats/:chatId/stop` in the handler. The step in progress is dropped (its text and reasoning were cut off), steps that finished are saved with `metadata.stopped: true`, and the run completes, so crash recovery never resumes it; a subagent it started stops with it. A closed tab or dropped connection still never stops an answer. On the server running it the stop is immediate; from another server it goes through the run row (`stopRequestedAt`, the new optional `StorageAdapter.requestStop`) and is noticed within `stopCheckMs` (default 1000). `runAgent` takes an `abortSignal` and returns `stopped: true`. The model call now always gets an abort signal, not only with durability on. The drizzle adapters add the `stop_requested_at` column (migrated), and `getRun` checks an owner key without a second query.
