---
"@intentface/latch-core": minor
"@intentface/latch-server": minor
---

Clearer names and typed tools.

- server: `resolveContext` is now `resolvePrincipal` in `createLatchHandler`, `createLatchApp` and `createLatchHonoApp`. It returns the principal; "context" is what your context function builds from it, and the old name mixed the two up. `resolveContext` still works, marked deprecated; pass one or the other. Leaving out both now fails when the handler is built, with a message naming `resolvePrincipal`. New exported type `PrincipalResolver<P>`.
- core: `toolFor<Principal, Ctx, Params?, MessageContext?>()`, for typing only: the AI SDK's `tool()` with `options.context` typed as `ToolContext<…>`, so tools no longer need `context as ToolContext<Principal, Ctx>`. Nothing changes at runtime; it returns an ordinary `Tool`, and plain `tool()` with the cast keeps working. Make it once per app.
- docs: the quickstart no longer reads the user from an `x-user` header (anyone could claim to be anyone if copied as-is). It uses one demo user and refuses every request (401) when `NODE_ENV` is `production`, until replaced with a real login. Tool examples use `toolFor`.
