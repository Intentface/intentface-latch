---
"@intentface/latch-core": patch
"@intentface/latch-server": patch
"@intentface/latch-drizzle": patch
---

A turn the client saw is a turn the server has.

- A tool result that can't be stored as it is (it holds a function, say) no longer fails the step after it was streamed. It is reduced to its JSON form, as storage keeps it. A result with no JSON form (a cycle, a BigInt) fails as that tool's error, which the model reads; the rest of the step stands.
- `applyToolResult` and `POST agents/:agent/:chatId/tool-result` refuse an answer to a tool call the chat doesn't hold with `ToolCallNotFoundError` (`tool_call_not_found`, 409). They answered an empty `200` before, the same as for a call that was already answered, which still is a no-op `200`.
- An answer that was streamed and can't be saved leaves its run `errored` (it said `completed`), and the client's stream ends as a failure.
- Answers to several questions from one step no longer lose each other when they arrive together. Each request used to save its own copy of the message, so one answer was dropped, every request answered an empty `200`, and the turn never resumed. Storage adapters get an optional `replaceMessage(chatId, expected, message, scope?)`, a compare-and-swap the runtime uses for an answer that waits for the others. The shipped adapters implement it; one without it behaves as before.
