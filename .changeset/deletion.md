---
"@intentface/latch-core": minor
"@intentface/latch-drizzle": minor
"@intentface/latch-server": minor
"@intentface/latch-agent-builder": minor
"@intentface/latch-memory": minor
---

**Deleting data.** Removing a person's data on request, or a customer who leaves, no longer means SQL behind Latch's back.

- `runtime.deleteChat({ principal, chatId })` deletes a chat with its messages, runs and usage, and the subagent threads it spawned. It refuses while an answer is running (`ChatBusyError`). The handler serves it as `DELETE chats/:id` (`404` when the chat isn't the caller's, `409` while busy, `501` when storage can't delete).
- `runtime.purgeOwner(segments, { also })` deletes everything stored for an owner path: `[orgId]` for an organization and everyone in it, `[orgId, userId]` for one person.
  - It runs every store until done and returns counts per store.
  - It checks first that every store can purge, and refuses (`UnsupportedOperationError`) before deleting anything if one can't.
- **New optional `purgeOwner`** on `StorageAdapter`, `SecretStore`, `AgentBuilderStore` and `MemoryJobStore`. It works in passes (`{ removed, done }`), is idempotent, and matches by prefix with a plain comparison, never SQL `LIKE`. `isUnderOwner(key, segments)` states the rule.
- **New optional `deleteChat`** on `StorageAdapter`.
- **latch-drizzle implements all of them.** Live runs are fenced before their chat goes, so a worker still running one can't write it back. The agent store also removes the drafts a person is writing in an organization's agents.
- **Conformance kit:** `deleteChat` (scoped, complete, refuses a live run) and `purgeOwner` (passes, idempotent, another owner untouched, a live run fenced out).
