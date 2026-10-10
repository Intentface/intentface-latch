import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { LatchHandler } from "./handler.js";

/**
 * The Latch handler for Node's `req` / `res`: Express, Fastify, NestJS, or a
 * plain `http.createServer`. Request bodies and answers stream through; nothing
 * is buffered.
 *
 * The returned function resolves `true` when it answered the request and
 * `false` when the path isn't a Latch route, so your app can carry on:
 *
 * ```ts
 * const latch = toNodeHandler(createLatchHandler({ runtime, resolveContext, basePath: "/api/latch" }));
 * app.all("/api/latch/*", async (req, res, next) => {
 *   if (!(await latch(req, res))) next();
 * });
 * ```
 *
 * On Fastify, and NestJS on Fastify, pass the raw objects: `latch(request.raw, reply.raw)`.
 */
export function toNodeHandler(
  handler: LatchHandler,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const response = await handler(toWebRequest(req));
    if (!response) return false;
    await writeNodeResponse(response, res);
    return true;
  };
}

/** Node request → Web Request, streaming the body. */
function toWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? "localhost";
  // A proxy chain sends "https,http": the first is what the client used.
  const forwarded = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() || "http";
  const url = new URL(req.url ?? "/", `${proto}://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else if (value !== undefined) headers.set(key, value);
  }

  const method = req.method ?? "GET";
  return new Request(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : bodyOf(req),
    duplex: "half",
  } as RequestInit);
}

/**
 * The request body. A body parser that ran first (`express.json()`, say) has
 * already read the stream and left the result on `req.body`; send that on
 * instead of an empty stream, so a turn doesn't arrive blank.
 */
function bodyOf(req: IncomingMessage): BodyInit | undefined {
  const parsed = (req as IncomingMessage & { body?: unknown }).body;
  if (req.readableEnded && parsed !== undefined) {
    if (typeof parsed === "string" || parsed instanceof Uint8Array) return parsed as BodyInit;
    return JSON.stringify(parsed);
  }
  return Readable.toWeb(req) as ReadableStream;
}

/** Web Response → Node response, streaming. */
async function writeNodeResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    // Headers joins several Set-Cookie values into one, which breaks them.
    if (key !== "set-cookie") res.setHeader(key, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  if (!response.body) {
    res.end();
    return;
  }
  // pipeline, not pipe: on an error, or when the client leaves, it closes both
  // ends. A bare pipe leaves the error unhandled, and that can take the process
  // down. The turn itself carries on and is saved on the server either way.
  await pipeline(Readable.fromWeb(response.body as never), res).catch(() => {});
}
