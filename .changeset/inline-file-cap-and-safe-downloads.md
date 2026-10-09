---
"@intentface/latch-core": minor
---

Safer file handling, ahead of the attachment store (#179).

- **Downloading file URLs for the model is bounded, and refused where it can't be checked.** When a model can't fetch a file part's URL itself, the server downloads it. On Node this still uses the AI SDK's download, which checks the URL, every redirect and the address actually connected to. Latch now caps each file at 50 MB (the SDK allowed 2 GiB) and 60 seconds, redirects and body included. On runtimes where the SDK can only check the URL text (Bun, Deno, edge, workerd), Latch refuses such downloads instead of risking a request to a private address. Send the file inline there, or use a model that fetches URLs itself. URLs the model fetches itself are unaffected. This applies to chat turns and to compaction.
- **Files sent inline are capped.** A user message's inline files (`data:` URLs, in any letter case, how `useChat` sends attachments by default) may total at most `maxInlineFileBytes` (a new runtime option, default 20 MB). A message over that is refused with `InvalidMessageError` (HTTP 400) before anything is stored. Files sent by URL are not counted.

**Upgrading:** if your users send more than 20 MB of files inline in one message, raise `maxInlineFileBytes`. On Bun, Deno or edge runtimes, file URLs a model can't fetch itself now fail instead of being downloaded unchecked.
