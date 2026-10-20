---
"@intentface/latch-core": minor
"@intentface/latch-server": minor
---

Clearer names and typed tools.

- server: `resolveContext` is now `resolvePrincipal` in `createLatchHandler`, `createLatchApp` and `createLatchHonoApp`. It returns the principal; "context" is what your context function builds from it, and the old name mixed the two up. `resolveContext` still works, marked deprecated; pass one or the other. Leaving out both now fails when the handler is built, with a message naming `resolvePrincipal`. New exported type `PrincipalResolver<P>`.
- core: `toolFor<Principal, Ctx, Params?, MessageContext?>()` returns the AI SDK's `tool()` with `options.context` typed as `ToolContext<…>`, so tools no longer need `context as ToolContext<Principal, Ctx>`. Make it once per app; it returns a plain `Tool`.
- docs: the quickstart no longer reads the user from an `x-user` header (anyone could claim to be anyone if copied as-is). It uses one demo user and refuses every request (401) when `NODE_ENV` is `production`, until replaced with a real login. Tool examples use `toolFor`.
