---
"@intentface/latch-core": patch
---

Non-`Error` throws and empty-message errors are described instead of masked.

`clientErrorMessage` already forwarded real `Error` messages, but a non-`Error` throw (a raw
HTTP body, a JSON-RPC error object, a plain string) or an `Error` with an empty message
collapsed to the bare "An error occurred." — which turned an MCP server's
`404 {"error":"Session not found"}` into an undebuggable generic string in the chat. Such
values are now serialized (bounded at 300 chars, cycle-safe) into the client-visible error
text; named error classes with empty messages report their name.
