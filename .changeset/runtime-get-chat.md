---
"@intentface/latch-core": minor
---

`runtime.getChat({ principal, id })` — one chat by id, scoped to the caller.

A direct lookup backed by `storage.getChat`, so "does this chat exist, and whose agent is it?"
stays correct for a tenant with any number of chats. Previously the only read was `listChats`,
which is a capped scan: anything past the limit is invisible, which silently breaks id-based
questions for busy tenants.
