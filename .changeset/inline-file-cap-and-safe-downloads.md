---
"@intentface/latch-core": minor
---

Safer file handling, ahead of the attachment store (#179).

- **File URLs are downloaded through `@intentface/latch-net`.** When a file part's URL can't be fetched by the model itself, Latch downloads it and sends the bytes. Before, the AI SDK's default download did this, and its private-address check only reads the URL, so a public hostname resolving to an internal address got through. Now every hop goes through latch-net's pinned fetch, which checks the address actually connected to. Redirects are followed one checked hop at a time, only `http`/`https` is allowed, and each file is capped at 50 MB. This applies to chat turns and to compaction. Without `@intentface/latch-net` installed, downloads fall back to the SDK's check, with a one-time warning.
- **Files sent inline are capped.** A user message's inline files (`data:` URLs, how `useChat` sends attachments by default) may total at most `maxInlineFileBytes` (new runtime option, default 20 MB). A message over that is refused with `InvalidMessageError` (HTTP 400) before anything is stored. Files sent by URL are not counted.

**Upgrading:** if your users send more than 20 MB of files inline in one message, raise `maxInlineFileBytes` or send them by URL.
