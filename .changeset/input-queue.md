---
"@intentface/latch-core": minor
"@intentface/latch-drizzle": minor
"@intentface/latch-server": minor
---

An input queue: what arrives while an answer is running is held, and the answer that ends starts the next turn with all of it.

- `handleChat({ ifBusy: "queue" })`, or `queue: true` in the body of `POST agents/:agent/:chatId`: a message sent to a busy chat is held and answered `202 { queued: { id } }`, where it was refused with `chat_busy`. The default is unchanged.
- `sendSignal` on a busy chat, or one waiting on an approval or tool result, now holds the signal and returns `{ id, queued: true }`; its turn starts when the chat is free. Before, it waited for the user's next message. `wake: false` is unchanged.
- One turn takes everything held, signals read with the messages. A chat holds at most `inputQueue.max` inputs (20 by default); past it a message is refused with `QueueFullError` (`queue_full`, 429).
- `runtime.listQueued`, `runtime.cancelQueued`, and `DELETE chats/:chatId/queue/:messageId`.
- `runtime.pollChat` and `GET chats/:chatId/poll?cursor=…`: whether an answer is running, what is held, and the history when it changed. For a page with no stream open.
- Storage: three optional methods, `enqueueInput`, `listQueuedInputs`, `removeQueuedInputs`, covered by the conformance suite. The Drizzle adapters implement them on a new `latch_queued_inputs` table; run `migrate`. An adapter without them behaves as before. `listRuns` takes `chatId`.
