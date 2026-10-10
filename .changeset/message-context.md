---
"@intentface/latch-core": minor
---

**`data-context`: what the user is looking at, on their message.** A client can attach one `{ type: "data-context", data: { … } }` part to a user message, for example the open file, the selection or a model pick:

- **The model** reads it as text in that message, after what the user wrote. The default wording is a `[Context]` block of `key: value` lines; `createRuntime({ messageContext: { toModel } })` changes it, and an agent can override it in its `defineAgent` meta (return `undefined` to leave it out).
- **Agent functions and tools** get the latest one as data: `messageContext`.
- **Chat UIs** don't render data parts, so the user doesn't see it.

It's saved with its message. A continuation of the answer (after an approval, or a crash) therefore sees the same values, and the instructions stay the same between messages, so prompt caching keeps working: no more per-message state in the system prompt.

`messageContext.schema` checks it when a message arrives (a mismatch is refused, 400). Without a schema it's free-form JSON, at most 32 KB, one per message, and never the only part of a message. Like params, it describes; it never authorizes.
