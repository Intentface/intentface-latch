---
"@intentface/latch-core": patch
"@intentface/latch-server": patch
"@intentface/latch-drizzle": patch
---

Stock `useChat` clients work fully with the chat route.

- **Attachments and message ids survive `useChat`'s default body.** With the default transport (`{ messages }`), the server used to rebuild the newest message as text only, under a new id: images and files never reached the model and disappeared from the chat. The newest message now goes to `handleChat` as sent, which keeps its id and its files (and `useChat`'s approval answers).
- **The last question can be regenerated or edited.** `regenerate()` resends the last question unchanged; `sendMessage({ messageId })` resends it edited. Either way, what it replaces (the answers after it, and an edit's earlier wording) is hidden from the user and the model but stays stored, and the agent answers again. The edited question keeps its id, so it can be edited again. Since 0.15.0 both were refused with 400. Crash recovery and approvals never continue a hidden answer, a refused turn (a limit, a busy chat) hides nothing, and memory extraction skips hidden messages.
- **An earlier question is refused with 409 `rewind_not_supported`** (`RewindNotSupportedError`) instead of a generic 400. Changing it in place would hide everything after it, including what the agent did since. Fork the chat at that question instead.
- **User message parts are rebuilt from their known fields:** text keeps `text`; a file keeps `mediaType`, `url` and `filename`. Other fields, such as `providerMetadata`, which would become options on the model call, are dropped. A text or file part missing those fields is refused.
