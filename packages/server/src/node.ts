import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { TLSSocket } from "node:tls";
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
 * const latch = toNodeHandler(createLatchHandler({ runtime, resolvePrincipal, basePath: "/api/latch" }));
 * app.all("/api/latch/*", async (req, res, next) => {
 *   if (!(await latch(req, res))) next();
 * });
 * ```
 *
 * On Fastify, and NestJS on Fastify, pass the raw objects, and the body if
 * Fastify already parsed it: `latch(request.raw, reply.raw, request.body)`.
 * Better still, give the Latch route a passthrough content-type parser so the
 * body streams (see the docs).
 *
 * It rejects if the answer's stream fails partway (the response is cut off);
 * a client that leaves mid-answer is not an error.
 */
export function toNodeHandler(
  handler: LatchHandler,
): (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => Promise<boolean> {
  return async (req, res, parsedBody) => {
    const response = await handler(toWebRequest(req, parsedBody));
    if (!response) return false;
    await writeNodeResponse(response, res);
    return true;
  };
}

/** Node request → Web Request, streaming the body. */
function toWebRequest(req: IncomingMessage, parsedBody: unknown): Request {
  const host = req.headers.host ?? "localhost";
  // A proxy chain sends "https,http": the first is what the client used.
  // Without a proxy, the socket says whether this connection is TLS.
  const forwarded = req.headers["x-forwarded-proto"];
  const proto =
    (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() ||
    ((req.socket as TLSSocket | undefined)?.encrypted ? "https" : "http");
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
    body: method === "GET" || method === "HEAD" ? undefined : bodyOf(req, parsedBody),
    duplex: "half",
  } as RequestInit);
}

/**
 * The request body: the stream, unless a body parser read it first
 * (`express.json()`, Fastify's default parser). Then it's what the parser left,
 * on `req.body` or passed in, encoded again for the request's content type.
 */
function bodyOf(req: IncomingMessage, given: unknown): BodyInit | undefined {
  // Fastify's passthrough parser hands the stream itself back as the body.
  const passed = given instanceof Readable ? undefined : given;
  if (passed === undefined && !req.readableEnded) return lazyBodyOf(req);
  const fromParser = passed ?? (req as IncomingMessage & { body?: unknown }).body;
  if (fromParser === undefined) {
    throw new Error(
      "The request body was already read and nothing was kept: mount the Latch route before your body parser.",
    );
  }
  if (typeof fromParser === "string" || fromParser instanceof Uint8Array) return fromParser as BodyInit;
  const type = String(req.headers["content-type"] ?? "").toLowerCase();
  if (type.includes("application/x-www-form-urlencoded")) return formOf(fromParser);
  if (type === "" || type.includes("json")) return JSON.stringify(fromParser);
  throw new Error(
    `The request body was already parsed (${type}) and can't be sent on as it arrived: ` +
      "mount the Latch route before your body parser.",
  );
}

/**
 * The request's body as a Web stream that doesn't touch `req` until something
 * reads it. A route Latch declines leaves the body unread, for the host's next
 * handler. (`Readable.toWeb` starts reading as soon as it's called.)
 */
function lazyBodyOf(req: IncomingMessage): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reader ??= (Readable.toWeb(req) as ReadableStream<Uint8Array>).getReader();
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel: (reason) => reader?.cancel(reason),
    },
    // Pull only when read: the default high-water mark of 1 pulls at once.
    { highWaterMark: 0 },
  );
}

/** A parsed form (`{ a: "1", b: ["2", "3"] }`) as form-encoded text again. */
function formOf(parsed: unknown): URLSearchParams {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (typeof v === "object" && v !== null) {
        throw new Error("The form body was parsed into nested objects: mount the Latch route before your body parser.");
      }
      form.append(key, String(v));
    }
  }
  return form;
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
  try {
    await pipeline(Readable.fromWeb(response.body as never), res);
  } catch (e) {
    // The client leaving isn't a failure; the answer's own stream failing is.
    if (!CLIENT_LEFT.has((e as { code?: string }).code ?? "")) throw e;
  }
}

/** How a write fails when the client has gone. */
const CLIENT_LEFT = new Set(["ERR_STREAM_PREMATURE_CLOSE", "ECONNRESET", "EPIPE"]);
