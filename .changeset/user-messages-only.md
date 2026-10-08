---
"@intentface/latch-core": patch
"@intentface/latch-server": patch
---

`handleChat` accepts only a new user message. The message must have the `user` role and contain only text and file parts, and its id can't already be in the chat, except when resending the chat's last message after a dropped response. Latch now sets the message's `visibility` itself and keeps only `createdAt` and `voice` from the client's metadata. Anything else is refused with `InvalidMessageError` (code `invalid_message`), which the HTTP server answers with 400. Approval decisions still go through `applyApproval`.

**Upgrading:** update promptly. If your client sends anything other than text and files in a user message, it now gets a 400.
