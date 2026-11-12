---
"@intentface/latch-core": minor
---

`runtime.sendSignal`: add a note to a chat from server code without starting a turn. The agent reads it with the user's next message; nothing already stored changes, so the prompt cache still hits.

- A `notice` (the default) is the application speaking. It is sent as a system message after the user's next message on OpenAI models (direct or Azure) and on the Anthropic models that take one mid-conversation (direct, Vertex, or Bedrock through `@ai-sdk/amazon-bedrock/anthropic`), and as a `<notice>` block inside that message everywhere else. `resolveNoticePlacement` on the runtime overrides the choice per model.
- A `message` is a named person other than the chat's user, always read as a person speaking.
- Stored as an `AppMessage` with `role: "system"` and `metadata.signal`. Hidden from the user unless `visibility: "user"` is passed. A client can't create one.
- `toModelMessages` takes `notices` and `keepTrailingSignals`; `placeSignals`, `defaultNoticePlacement` and `isSignal` are exported.
