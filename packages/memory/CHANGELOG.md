# @intentface/latch-memory

## 0.20.0

### Minor Changes

- 58a56e2: **Deleting data.** Removing a person's data on request, or a customer who leaves, no longer means SQL behind Latch's back.
  
  - `runtime.deleteChat({ principal, chatId })` deletes a chat with its messages and runs, and the subagent threads it spawned. Its usage rows stay: the ledger records what was spent. It refuses while an answer is running (`ChatBusyError`). The handler serves it as `DELETE chats/:id` (`404` when the chat isn't the caller's, `409` while busy, `501` when storage can't delete).
  - `runtime.purgeOwner(segments, { also })` deletes everything stored for an owner path: `[orgId]` for an organization and everyone in it, `[orgId, userId]` for one person.
    - It runs every store until done and returns counts per store.
    - **Usage is kept by default**, re-filed one level up (`[orgId, userId]` → `[orgId]`) with its run id cleared, so billing totals stay right. Choose with `usage: "refile" | "keep" | "delete"` and `refileTo`. A one-segment path (a whole tenant) has nothing above it, so it needs `usage: "delete"` or `"keep"`.
    - It checks first that every store can purge, and refuses (`UnsupportedOperationError`) before deleting anything if one can't.
  - **New optional `purgeOwner`** on `StorageAdapter`, `SecretStore`, `AgentBuilderStore` and `MemoryJobStore`. It works in passes (`{ removed, done }`), is idempotent, and matches by prefix with a plain comparison, never SQL `LIKE`. `isUnderOwner(key, segments)` states the rule.
  - **New optional `deleteChats(principal, ids)`** on `StorageAdapter`: all or nothing, refusing with `ChatBusyError` if any of the chats has an answer running.
  - **latch-drizzle implements all of them.**
    - Run and message inserts look their chat up, so nothing can land for a deleted chat as an orphan. On Postgres the lookup waits for a deletion of that chat to commit, which serializes deleting a chat with a run starting in it.
    - A purge fences live runs before their chat goes.
    - The agent store also removes the drafts a person is writing in an organization's agents.
  - **Conformance kit:**
    - `deleteChats`: scoped, complete, all or nothing around a live run, and a deleted chat can't be written to.
    - `purgeOwner`: works in passes, idempotent, another owner untouched, a live run fenced out.
  
  **Fix:** an answer that failed partway never wrote its spend to the usage ledger, or onto its run, though it counted against limits. It now does both, so a bill from the ledger includes failed answers.

### Patch Changes

- Updated dependencies [58a56e2]
  - @intentface/latch-core@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [302f5c0]
  - @intentface/latch-core@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [666085c]
- Updated dependencies [7339995]
  - @intentface/latch-core@0.18.0

## 0.17.1

### Patch Changes

- a132539: Memory is now marked **experimental**: the `memory` options on `createRuntime` and `defineAgent`, the `@intentface/latch-memory` package and its docs. The only production store today is a Loredex workspace, and the interface still carries Loredex conventions, so the design may change in any release. Nothing changes in behaviour.
- Updated dependencies [a132539]
- Updated dependencies [0bee5fd]
  - @intentface/latch-core@0.17.1

## 0.17.0

### Patch Changes

- Updated dependencies [e16480d]
- Updated dependencies [39c2910]
- Updated dependencies [744431b]
  - @intentface/latch-core@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [a8e7b0d]
- Updated dependencies [d655b0c]
  - @intentface/latch-core@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [d4356e3]
- Updated dependencies [d77af82]
  - @intentface/latch-core@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [ab7a88e]
  - @intentface/latch-core@0.14.0

## 0.13.3

### Patch Changes

- Updated dependencies [4fe9ecd]
  - @intentface/latch-core@0.13.3

## 0.13.2

### Patch Changes

- Updated dependencies [dfe9b90]
  - @intentface/latch-core@0.13.2

## 0.13.1

### Patch Changes

- Updated dependencies [6fed7fa]
- Updated dependencies [cf10a1c]
  - @intentface/latch-core@0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies [3b0dbfb]
- Updated dependencies [71630e1]
- Updated dependencies [80f1630]
- Updated dependencies [015e0a1]
- Updated dependencies [96013b6]
  - @intentface/latch-core@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [e602c55]
  - @intentface/latch-core@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [ae91f9c]
  - @intentface/latch-core@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [65d1de5]
- Updated dependencies [c70daf1]
  - @intentface/latch-core@0.10.0

## 0.9.1

### Patch Changes

- 8311508: Publish to the public npm registry.
  
  Installing no longer needs an `.npmrc`, a registry mapping or a token:
  `pnpm add @intentface/latch-core` just works. Every tarball now ships the MIT
  license text, and each manifest carries `keywords`, `homepage` and `bugs`.
  
  No code or API changes. The versions previously published to GitHub Packages
  stay where they are; new releases go to npm only.
- Updated dependencies [4b5e9eb]
- Updated dependencies [8311508]
- Updated dependencies [516d8f0]
- Updated dependencies [8fd120a]
  - @intentface/latch-core@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [ebc0afd]
- Updated dependencies [d062dd2]
- Updated dependencies [8745142]
- Updated dependencies [cbbd775]
- Updated dependencies [78a40e3]
- Updated dependencies [7d3c553]
- Updated dependencies [b22b3cf]
  - @intentface/latch-core@0.9.0

## 0.8.1

### Patch Changes

- Updated dependencies [e0e2000]
  - @intentface/latch-core@0.8.1

## 0.8.0

### Patch Changes

- Updated dependencies [c5a64fd]
  - @intentface/latch-core@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [fcef9d2]
- Updated dependencies [fcef9d2]
  - @intentface/latch-core@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [3721c48]
- Updated dependencies [8b9e1c8]
  - @intentface/latch-core@0.6.0

## 0.5.0

### Patch Changes

- @intentface/latch-core@0.5.0

## 0.4.1

### Patch Changes

- @intentface/latch-core@0.4.1

## 0.4.0

### Patch Changes

- @intentface/latch-core@0.4.0

## 0.3.1

### Patch Changes

- @intentface/latch-core@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [ddfa57b]
  - @intentface/latch-core@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [194c789]
- Updated dependencies [c782ec9]
  - @intentface/latch-core@0.2.0

## 0.1.0

### Patch Changes

- b00e813: Publish internal `@intentface/latch-*` dependencies as caret ranges instead of exact pins.
  
  These packages previously declared each other at an exact version, so installing two of
  them at different patch levels put a second copy of the shared package in `node_modules` —
  its own module registry, its own `instanceof` identities, and no error to say so. They now
  declare `^<version>`, which dedupes against the range in your own `package.json`.
  
  Nothing to do on your side beyond installing; a fresh install collapses any duplicate that
  an earlier version produced.
- Updated dependencies [166c7a8]
  - @intentface/latch-core@0.1.0

## 0.0.1

### Patch Changes

- Updated dependencies [9dd4f7a]
  - @intentface/latch-core@0.0.1
