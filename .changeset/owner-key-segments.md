---
"@intentface/latch-core": minor
"@intentface/latch-drizzle": minor
---

A storage `owner` that returns a missing or empty segment now throws, instead of filing the row under the string `"undefined"`. Before, `owner: (p) => [p.orgId, p.userId]` put every principal without a `userId` into one shared `orgId/undefined` bucket, so their chats, secrets or agents mixed without an error. Return a shorter path for those principals (`p.userId ? [p.orgId, p.userId] : [p.orgId]`), or throw for one that can't have a key.

The checked encoder is exported as `encodeOwnerKey(segments)` from `@intentface/latch-core`, for your own adapters and owner-scoped tables.
