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

Express, Fastify and NestJS predate `Request`/`Response`, so they need a bridge between Node's `req`/`res` and the Web objects. **Write it once** — all three then use the same helper.

```ts title="node-bridge.ts"
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LatchHandler } from "@intentface/latch-server";

/** Node request → Web Request. */
function toWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? "localhost";
  const proto = (req.headers["x-forwarded-proto"] as string) ?? "http";
  const url = new URL(req.url ?? "/", `${proto}://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    // Stream the body rather than buffering it.
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    duplex: "half",
  } as RequestInit);
}

/** Web Response → Node response, streaming (never buffered). */
async function writeNodeResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) return void res.end();
  // pipeline, not pipe: on an error (or the client leaving) it closes both
  // ends; a bare pipe leaves the error unhandled and can take the process down.
  // The turn itself finishes and is saved server-side either way.
  await pipeline(Readable.fromWeb(response.body as never), res).catch(() => {});
}

/** Returns false when Latch doesn't own the route, so the host can continue. */
export function nodeAdapter(handler: LatchHandler) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const response = await handler(toWebRequest(req));
    if (!response) return false;
    await writeNodeResponse(response, res);
    return true;
  };
}
```

> **Do not body-parse the Latch route**
>
> `express.json()`, Fastify's default parser and NestJS's global pipes all consume
> the request stream. If one runs first, the bridge hands Latch an empty body and
> every turn arrives blank. Mount the parser *after* the Latch route, or exclude
> the path.

> **Do not buffer the response**
>
> Turns stream. Anything that collects the body before writing it — a compression
> middleware without flush, `res.json(await response.text())` — turns a live
> stream into one late blob, and the UI shows nothing until the turn ends.

**Express**

```ts
import express from "express";
import { nodeAdapter } from "./node-bridge";
import { latch } from "./latch-handler";

const app = express();
const handle = nodeAdapter(latch);

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

Fastify parses bodies by default, so register a passthrough parser and use the
raw Node objects:

```ts
import Fastify from "fastify";
import { nodeAdapter } from "./node-bridge";
import { latch } from "./latch-handler";

const app = Fastify();
const handle = nodeAdapter(latch);

// Leave the body alone — the bridge streams it.
app.addContentTypeParser(/.*/, (_req, payload, done) => done(null, payload));

app.all("/api/latch/*", async (request, reply) => {
  reply.hijack(); // we own the raw socket from here
  if (!(await handle(request.raw, reply.raw))) {
    reply.raw.statusCode = 404;
    reply.raw.end();
  }
});

await app.listen({ port: 3000 });
```

**NestJS**

The same bridge applies — reach for the underlying request and skip Nest's
pipes on this route. This is NestJS on Express; on Fastify, `@Req()` and
`@Res()` are Fastify's objects, so pass `req.raw` and `res.raw` to `handle`:

```ts title="latch.controller.ts"
import { All, Controller, Next, Req, Res } from "@nestjs/common";
import type { IncomingMessage, ServerResponse } from "node:http";
import { nodeAdapter } from "./node-bridge";
import { latch } from "./latch-handler";

const handle = nodeAdapter(latch);

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
| `GET` | `runs` | run records, for an admin or debug view |
| `GET` `POST` `DELETE` | `schedules` · `schedules/:id` | manage scheduled agents |
| `GET` | `connections` | connection status for the caller |
| `GET` | `connections/:name/authorize` · `callback` | the OAuth dance |
| `POST` | `connections/:name/disconnect` · `test` | revoke, or check liveness |
| `POST` | `cron/run` | `runtime.cron()`: fire all tenants' due schedules, reap + resume stalled runs |

The turn route accepts `{ message }`, `{ text }`, or a `useChat`-style `{ messages }` array and takes the last one — so an AI SDK client works without a translation layer.

### Refusals a client should expect

| Status | `code` | Meaning | What the client does |
| --- | --- | --- | --- |
| `409` | `pending_approval` | A decision is outstanding on this chat. | Render the approval; resolve it first. |
| `409` | `chat_busy` | A turn is already running in this chat (two tabs, a retry racing a reply). Nothing was persisted. | Wait `Retry-After` (also `retryAfterMs` in the body) and resend the same message. |
| `409` | `chat_conflict` | The client-chosen chat id exists and isn't yours. | Pick another id. |
| `429` | `limit_exceeded` | A turn, token or cost budget is spent. | Wait `Retry-After`; tell the user which budget. |

## The cron route

`POST cron/run` is the only route that isn't user-authenticated: it fires **every** tenant's due schedules, so there's no principal to check. Guard it with a shared secret, sent as `x-latch-cron-secret`:

```ts
createLatchHandler({
  runtime,
  resolveContext,
  cronSecret: process.env.LATCH_CRON_SECRET,
});
```

Omit `cronSecret` and the route doesn't exist at all — it fails closed. Point any scheduler that can send a `POST` with that header at it.

> **Vercel Cron**
>
> Vercel Cron sends a `GET` with `Authorization: Bearer $CRON_SECRET`, which this route doesn't accept. Use a five-line route that calls `runtime.cron()` instead: see [Deploy on Vercel](./deploy-on-vercel.md#4-the-cron).

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
