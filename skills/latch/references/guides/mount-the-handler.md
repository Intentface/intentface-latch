<!-- Generated from apps/docs/content/docs/guides/mount-the-handler.mdx by apps/docs/scripts/build-skill.mjs. Edit the page, not this file. -->

# Mount in your framework

One Web-standard handler, mounted in Hono, Express, Fastify, NestJS, or any framework that speaks Request and Response.

Online: https://intentface-latch-docs.vercel.app/docs/guides/mount-the-handler

> **Shortest path**
>
> `createLatchApp({ storage, agents, resolveContext })` wires the runtime with every default — durability, cron, model catalog, harness tools — and returns `{ runtime, handler, models, stop }`, the `handler` being the one described below, already mounted over that runtime. `createLatchHonoApp` returns the same plus `app`. The rest of this page is for when you want to assemble the pieces yourself.

`@intentface/latch-server` gives you the whole runtime as **one handler**:

```ts
type LatchHandler = (request: Request) => Promise<Response | undefined>
```

`undefined` means "not one of my routes" — hand the request back to your host. That single signature is why the same code mounts everywhere.

```ts title="latch-handler.ts"
import { createLatchHandler } from "@intentface/latch-server";
import { runtime } from "./latch";

export const latch = createLatchHandler({
  runtime,
  basePath: "/api/latch",
  // Your existing auth, returning your Principal. Null → 401.
  resolveContext: async (request) => {
    const session = await auth.getSession(request);
    return session ? { orgId: session.orgId, userId: session.userId } : null;
  },
});
```

> **The routes are a convenience, not the contract**
>
> The real contract is the [Runtime methods](../reference/runtime.md). This handler is a
> pre-wired HTTP surface over them — you can ignore it and call `handleChat`,
> `sweep` or `schedule` from your own routes, a queue consumer, or a CLI.

## Web-standard hosts

Anything that already speaks `Request`/`Response` needs no adapter.

**Hono**

`latch-server` ships a Hono adapter on a subpath, so `hono` stays an optional peer:

```ts
import { Hono } from "hono";
import { createLatchHono } from "@intentface/latch-server/hono";

const app = new Hono();

// Your middleware still applies — auth, CORS, logging.
app.route("/api/latch", createLatchHono({ runtime, resolveContext }));

export default app;
```

Or mount the bare handler yourself if you want to control the fallthrough:

```ts
app.all("/api/latch/*", async (c) => (await latch(c.req.raw)) ?? c.notFound());
```

**TanStack Start**

```ts title="src/routes/api/latch.$.ts"
import { createServerFileRoute } from "@tanstack/react-start/server";
import { latch } from "~/lib/latch-handler";

const handle = async ({ request }: { request: Request }) =>
  (await latch(request)) ?? new Response("Not found", { status: 404 });

export const ServerRoute = createServerFileRoute("/api/latch/$").methods({
  GET: handle,
  POST: handle,
  DELETE: handle,
});
```

**Next.js**

```ts title="app/api/latch/[...path]/route.ts"
import { latch } from "@/lib/latch-handler";

const handle = async (request: Request) =>
  (await latch(request)) ?? new Response("Not found", { status: 404 });

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
```

Streaming turns need a Node runtime, not Edge, if your storage adapter uses a Node driver.

**Bun**

```ts
Bun.serve({
  port: 3000,
  fetch: async (request) => (await latch(request)) ?? new Response("Not found", { status: 404 }),
});
```

**Deno**

```ts
Deno.serve(async (request) =>
  (await latch(request)) ?? new Response("Not found", { status: 404 }),
);
```

## Node frameworks

Express, Fastify and NestJS predate `Request`/`Response`, so they go through `toNodeHandler` from `@intentface/latch-server/node`, which turns Node's `req`/`res` into the Web objects and back. Request bodies and answers stream through it; it resolves `false` for a path that isn't a Latch route, so your app can carry on.

```ts title="latch-handler.ts"
import { createLatchHandler } from "@intentface/latch-server";
import { toNodeHandler } from "@intentface/latch-server/node";

export const handle = toNodeHandler(createLatchHandler({ runtime, resolveContext, basePath: "/api/latch" }));
```

> **Do not body-parse the Latch route**
>
> `express.json()`, Fastify's default parser and NestJS's global pipes all consume
> the request stream. If one runs first, `toNodeHandler` sends Latch what it left on
> `req.body`, but uploads no longer stream, and a parser that keeps nothing leaves
> every turn blank. Mount the parser *after* the Latch route, or exclude
> the path.

> **Do not buffer the response**
>
> Turns stream. Anything that collects the body before writing it — a compression
> middleware without flush, `res.json(await response.text())` — turns a live
> stream into one late blob, and the UI shows nothing until the turn ends.

**Express**

```ts
import express from "express";
import { handle } from "./latch-handler";

const app = express();
// Before any body parser. Express 5 requires a NAMED wildcard — a bare
// "/api/latch/*" throws at registration. On Express 4 use "/api/latch/*".
app.all("/api/latch/*splat", async (req, res, next) => {
  if (!(await handle(req, res))) next();
});

app.use(express.json()); // the rest of your app
app.listen(3000);
```

Express 5 moved to `path-to-regexp` v8, which dropped anonymous `*`. Mounting
with `app.use("/api/latch", …)` also works and is version-agnostic — but note
`req.url` is then stripped of the mount prefix, so pass the same prefix as
`basePath` or the handler won't recognise its own routes.

**Fastify**

Fastify parses JSON before your route runs, and a catch-all content-type
parser can't override its built-in one. So give the Latch routes a plugin of
their own without Fastify's parsers: the body then streams. Pass the raw Node
objects, and `request.body` too, which covers a body Fastify did parse.

```ts
import Fastify from "fastify";
import { handle } from "./latch-handler";

const app = Fastify();

app.register(async (latch) => {
  // Only inside this plugin: let every body through unread, JSON included.
  latch.removeAllContentTypeParsers();
  latch.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

  latch.all("/api/latch/*", async (request, reply) => {
    reply.hijack(); // we own the raw socket from here
    if (!(await handle(request.raw, reply.raw, request.body))) {
      reply.raw.statusCode = 404;
      reply.raw.end();
    }
  });
});

await app.listen({ port: 3000 });
```

**NestJS**

The same handler applies — reach for the underlying request and skip Nest's
pipes on this route. This is NestJS on Express; on Fastify, `@Req()` and
`@Res()` are Fastify's objects, so pass `req.raw` and `res.raw` to `handle`:

```ts title="latch.controller.ts"
import { All, Controller, Next, Req, Res } from "@nestjs/common";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handle } from "./latch-handler";

@Controller("api/latch")
export class LatchController {
  // Named wildcard: Nest 11 runs Express 5, where a bare "*" is invalid.
  @All("*splat")
  async proxy(
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
    @Next() next: () => void,
  ): Promise<void> {
    if (!(await handle(req, res))) next();
  }
}
```

Using `@Res()` opts this route out of Nest's response handling, which is what
you want — Nest must not serialize a stream. Also exclude the path from
`bodyParser` in `main.ts` (`NestFactory.create(AppModule, { bodyParser: false })`
and apply parsers per-module, or `app.use(json({ ... }))` scoped to other paths).

## What the handler exposes

All paths are relative to `basePath`.

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `agents` | agents available to the caller, for a picker |
| `POST` | `agents/:agent/:chatId` | run a turn — returns the stream |
| `POST` | `agents/:agent/:chatId/approvals` | resolve a human-in-the-loop gate |
| `POST` | `agents/:agent/:chatId/tool-result` | answer a client-handled tool |
| `GET` | `chats` · `chats/:id` | the caller's chats, and one chat's history |
| `DELETE` | `chats/:id` | delete a chat and the subagent threads it spawned |
| `GET` | `runs` | run records, for an admin or debug view |
| `GET` `POST` `DELETE` | `schedules` · `schedules/:id` | manage scheduled agents |
| `GET` | `connections` | connection status for the caller |
| `GET` | `connections/:name/authorize` · `callback` | the OAuth dance |
| `POST` | `connections/:name/disconnect` · `test` | revoke, or check liveness |
| `GET` `POST` | `cron/run` | `runtime.cron()`, or your `cronRun`: fire all tenants' due schedules, reap + resume stalled runs |

The turn route accepts `{ message }`, `{ text }`, or a `useChat`-style `{ messages }` array and takes the last one — so an AI SDK client works without a translation layer.

### Refusals a client should expect

| Status | `code` | Meaning | What the client does |
| --- | --- | --- | --- |
| `409` | `pending_approval` | A decision is outstanding on this chat. | Render the approval; resolve it first. |
| `409` | `chat_busy` | A turn is already running in this chat (two tabs, a retry racing a reply). Nothing was persisted. | Wait `Retry-After` (also `retryAfterMs` in the body) and resend the same message. |
| `409` | `chat_conflict` | The client-chosen chat id exists and isn't yours. | Pick another id. |
| `429` | `limit_exceeded` | A turn, token or cost budget is spent. | Wait `Retry-After`; tell the user which budget. |

## The cron route

`cron/run` is the only route that isn't user-authenticated: it fires **every** tenant's due schedules and finishes interrupted answers, so there's no principal to check. Guard it with a shared secret, sent as `Authorization: Bearer <secret>` or in the `x-latch-cron-secret` header, with `GET` or `POST`:

```ts
createLatchHandler({
  runtime,
  resolveContext,
  cronSecret: process.env.LATCH_CRON_SECRET,
});
```

Omit `cronSecret` and the route doesn't exist at all — it fails closed.

> **Vercel Cron**
>
> Vercel Cron calls a URL with `GET` and `Authorization: Bearer $CRON_SECRET`, which this route accepts. Set `cronSecret: process.env.CRON_SECRET` (`createLatchApp` reads `CRON_SECRET` on its own) and point a cron in `vercel.json` at it: `{ "crons": [{ "path": "/api/latch/cron/run", "schedule": "* * * * *" }] }`.

Schedules also need a cron evaluator, since core ships no cron library:

```ts
import { createCronerEvaluator } from "@intentface/latch-server";

createRuntime({ /* … */ cron: createCronerEvaluator() });
```

On a long-lived Node process you can skip the HTTP route entirely and use the in-process scheduler instead — see [Turn on crash recovery](./crash-recovery.md).

## Multi-tenancy

`runtime` accepts a resolver as well as a value, which is how you choose between the two isolation models:

```ts
// One database, isolated by owner key on every row.
createLatchHandler({ runtime, resolveContext });

// A database per tenant — hard isolation.
createLatchHandler({
  runtime: (principal) => runtimeFor(principal.orgId),
  resolveContext,
  // No principal exists on cron/run, so supply the system-wide tick yourself.
  cronRun: async () => {
    for (const tenant of await listTenants()) {
      await (await runtimeFor(tenant)).cron();
    }
  },
});
```

Which one you want, and how the owner key follows from your `Principal`, is [Principals](./ownership-patterns.md).
