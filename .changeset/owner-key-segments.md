---
"@intentface/latch-core": minor
"@intentface/latch-drizzle": minor
---

A storage `owner` that returns a missing or empty segment now throws, instead of filing the row under the string `"undefined"`. Before, `owner: (p) => [p.orgId, p.userId]` put every principal without a `userId` into one shared `orgId/undefined` bucket, so their chats, secrets or agents mixed without an error. If you see the new error, decide what those principals should see. Return `[p.orgId]` only when a principal without a `userId` is *meant* to share the organization's data (a team chat, an org-wide secret); for personal data, throw in `owner` (or refuse them in your login) instead. A missing `userId` is not a reason to grant org-level access.

The checked encoder is exported as `encodeOwnerKey(segments)` from `@intentface/latch-core`, for your own adapters and owner-scoped tables.
