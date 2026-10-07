---
"@intentface/latch-server": patch
"@intentface/latch-core": patch
---

Attachments sent from a stock `useChat` client now reach the model, and a chat's history only ever gains a user message from the chat route.

- **File parts survive `{ messages }`.** `POST /agents/:agent/:id` rebuilt the last message of the AI SDK's default body (`DefaultChatTransport`) as text only, so images, PDFs and other file parts never reached storage or the model, and vanished from history on reload. Text and file parts are now kept.
- **The body is normalized, whatever its shape.** `{ message }` was stored verbatim. Now, for every body shape, `role` is always `user`, `metadata` is the server's (`visibility: "user"`, `createdAt`; a client's `metadata.voice` marker is kept), and parts other than `text` and `file` are dropped: tool, reasoning, source, `step-start` and `data-*` parts (a `data-compaction` part cut the model's context at that message whatever its role).
- **Message ids can't overwrite history.** The client's id is kept when it is a plain id the chat doesn't hold yet, so an optimistic message matches the stored one. `handleChat` and `runAgent` turns re-mint a message id the chat already holds: messages upsert by id, so a reused id (a `useChat` regenerate, or any client-chosen id) overwrote that earlier message in place, an assistant answer included.

**Upgrading:** nothing to do for a client that sends user messages. A client that posted `{ message }` with its own `role`, `visibility`, `sendToModel` or non-text/file parts and relied on them being stored will now see them replaced; send that data in the body (it reaches `context.build` as `turnContext`) or append it server-side.
