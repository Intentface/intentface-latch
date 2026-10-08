---
"@intentface/latch-core": patch
"@intentface/latch-server": patch
---

Stock `useChat` clients work fully with the chat route.

- **Attachments and message ids survive `useChat`'s default body.** With the default transport (`{ messages }`), the server used to rebuild the newest message as text only, under a new id: images and files never reached the model and disappeared from the chat. The newest message now goes to `handleChat` as sent, which keeps its id and its files (and `useChat`'s approval answers).
- **`regenerate()` works.** Resending the last user message unchanged hides the answers after it from the user and the model and answers again from that message. The hidden answers stay stored. Since 0.15.0 this was refused with 400. Crash recovery skips hidden answers, so a regenerate interrupted by a crash still finishes.
- **User message parts are rebuilt from their known fields:** text keeps `text`; a file keeps `mediaType`, `url` and `filename`. Other fields, such as `providerMetadata`, which would become options on the model call, are dropped. A text or file part missing those fields is refused.
