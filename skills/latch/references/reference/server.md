<!-- Generated from apps/docs/content/docs/reference/server.mdx by apps/docs/scripts/build-skill.mjs. Edit the page, not this file. -->

# Server

createLatchApp and createLatchHandler from @intentface/latch-server, every option, and the routes they serve.

Online: https://intentface-latch-docs.vercel.app/docs/reference/server

`@intentface/latch-server` serves the runtime over HTTP. What it's for: [Server](https://intentface-latch-docs.vercel.app/docs/concepts/server). Mounting it in your framework: [Mount in your framework](../guides/mount-the-handler.md).

## createLatchApp

Builds the runtime with sensible defaults (crash recovery, schedules, the model catalog, built-in tools) and the handler over it. Returns `{ runtime, handler, models, stop }`.

```ts
const { runtime, handler } = await createLatchApp<Principal>({ storage, agents, resolveContext });
```

| Option | Type | Description |
| --- | --- | --- |
| `storage` | `StorageAdapter<P>` | Where conversations, runs and usage are stored, for example `createPostgresAdapter(db, { owner })`. |
| `agents` | `Record<string, AgentFactory<P, any, any>> \| ((models: ModelCatalog) => Record<string, AgentFactory<P, any, any>>)` | Your agents, by name. Pass a function to get the model catalog, so an agent can pick its model by id: `(models) => ({ assistant: defineAgent({ model: models.modelFor("claude-sonnet-4-6"), … }) })`. |
| `resolveContext` | `(request: Request) => P \| Promise<P \| null> \| null` | Your login: turns a request into the principal, or `null` for a `401`. |
| `context` (optional) | `ContextInput<P, RC>` | What your agents and tools can work with, built from who is asking on every turn: `async ({ principal }) => ({ … })`. Default: ``{}``. |
| `models` (optional) | `ModelCatalog` | A model catalog you already loaded. Default: ``loadModelCatalog()``. |
| `principalKey` (optional) | `((principal: P) => string)` | A key per caller for prompt caching, so one person's cached prompt is never reused for another. Usually the same as the storage owner. |
| `runtime` (optional) | `Partial<Omit<RuntimeConfig<P, RC>, "agents" \| "context" \| "storage">>` | Any other `createRuntime` option (limits, connections, schedules…), or a different value for one of the defaults. |
| `handler` (optional) | `Partial<Omit<LatchHandlerConfig<P>, "resolveContext" \| "runtime">>` | Any other `createLatchHandler` option, such as `basePath`, `connections` or `cronSecret`. |
| `cronIntervalMs` (optional) | `number \| false` | How often to call `runtime.cron()` in this process, in ms, or `false` for never. Off on serverless (when `VERCEL` or `AWS_LAMBDA_FUNCTION_NAME` is set), where nothing runs between requests: call `runtime.cron()` from a cron route instead. Default: `30000 on a long-running server`. |

## createLatchHandler

The handler on its own, over a runtime you built. Returns `(request) => Promise<Response | undefined>`: `undefined` means the path isn't one of its routes.

```ts
const handler = createLatchHandler<Principal>({ runtime, resolveContext, basePath: "/api/latch" });
```

| Option | Type | Description |
| --- | --- | --- |
| `runtime` | `Runtime<P> \| ((principal: P) => Runtime<P> \| Promise<Runtime<P>>)` | The runtime the routes call. For a database per customer, pass a function instead: it gets the principal from `resolveContext` and returns that customer's runtime. In that case also set `cronRun`, because the cron route has no principal to pick a runtime with. |
| `resolveContext` | `(request: Request) => P \| null \| Promise<P \| null>` | Your login: turns a request into the principal, or `null` for a `401`. Not used when a sign-in to a connection returns (the OAuth callback): the principal that started the sign-in is saved with it and restored with `reconstructPrincipal`, so whatever session the returning browser has can't change whose account the credentials are saved to. |
| `reconstructPrincipal` (optional) | `((identity: unknown, request: Request) => P \| null \| Promise<P \| null>)` | Restores the principal that started a connection sign-in, when the sign-in returns. Check it's still valid here (for example, still a member); return `null` to refuse with a `401`. By default the saved principal is used as is. |
| `oauthFlowMaxAgeMs` (optional) | `number` | How long a user has to finish signing in to a connection. A later return redirects with `?error=flow_expired`. Default: `30 minutes`. |
| `connections` (optional) | `McpConnections<P> \| ((principal: P) => McpConnections<P> \| Promise<McpConnections<P>>)` | The services users can connect, from `createMcpConnections`. Adds the routes to list, sign in to, test and disconnect them. Pass a function to give each customer their own set. |
| `onConnected` (optional) | `((principal: P, connectionName: string) => void \| Promise<void>)` | Called after a user connects a service, including when they were already connected. |
| `onError` (optional) | `((error: unknown, info: { route: string; name?: string; }) => void \| Promise<void>)` | Receives errors the client is only told about briefly. A connection's errors can quote the other server's response, so the client gets a short code and the full error comes here. Wire it to your logger, or the detail is lost. |
| `connectedParam` (optional) | `string` | The query parameter that tells your page which service was just connected, after a sign-in returns: `?connected=linear`. Default: `"connected"`. |
| `basePath` (optional) | `string` | Where the handler is mounted, for example `"/api/latch"`. Default: `"/"`. |
| `cronSecret` (optional) | `string` | Turns on `cron/run`, which calls `runtime.cron()` for every customer: fires due schedules and finishes interrupted answers. Requests must carry this secret, as `Authorization: Bearer <secret>` or in the `x-latch-cron-secret` header, with `GET` or `POST`. That means Vercel Cron can call it directly: set this to `process.env.CRON_SECRET` and point `vercel.json` at the route. Leave it out and the route doesn't exist. |
| `cronRun` (optional) | `(() => Promise<unknown>)` | What `POST /cron/run` does. Needed with a database per customer: call `cron()` on each customer's runtime. Default: ``runtime.cron()``. |

## Routes

Paths are relative to `basePath`. Every route except the cron route and the connection sign-in callback calls `resolveContext` first. The callback restores the principal that started the sign-in instead (see `reconstructPrincipal` above).

| Route | What it does |
| --- | --- |
| `GET agents` | The agents the caller can use, for a picker. |
| `POST agents/:agent/:chatId` | Send a message; streams the answer. Body: `{ message }` or the AI SDK's `{ messages }`. |
| `POST agents/:agent/:chatId/approvals` | Approve or deny paused tools; streams the rest of the answer. |
| `POST agents/:agent/:chatId/tool-result` | Answer a tool the browser handles, such as a question for the user. |
| `GET chats` | The caller's chats. |
| `GET chats/:chatId` | One chat's messages. |
| `DELETE chats/:chatId` | Delete the chat with its messages, runs and usage, and the subagent threads it spawned. `404` if it isn't the caller's, `409` while an answer runs, `501` if storage can't delete. |
| `GET runs` | The caller's runs, with usage and cost. |
| `GET schedules`, `POST schedules` | List or create the caller's schedules. |
| `GET schedules/:id`, `DELETE schedules/:id` | Read or delete one. |
| `POST schedules/:id/run-now` | Fire it on the next cron tick. |
| `GET connections` | The services the caller can connect, and which are connected. |
| `GET connections/:name/authorize` | Start signing in; redirects to the provider. |
| `GET connections/:name/callback` | Where the provider sends the user back. |
| `POST connections/:name/disconnect` | Remove the caller's credentials. |
| `POST connections/:name/test` | Check the connection works; returns its tool names. |
| `GET` / `POST cron/run` | Your `cronRun`, or by default `runtime.cron()` for everyone (with a runtime per customer and no `cronRun`, it answers `400`). Needs `cronSecret`, as a bearer token or `x-latch-cron-secret`, so Vercel Cron can call it. |

Refusals come back as JSON with a `code`: see [Errors](./errors.md).
