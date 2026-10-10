import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { toNodeHandler } from "./node.js";

/**
 * The Node adapter, against a real `http` server: bodies in, streamed answers
 * out, cookies kept apart, and a "not mine" that lets the host carry on.
 */

let server: Server | undefined;
afterEach(
  () =>
    new Promise<void>((done) => {
      if (!server) return done();
      server.close(() => done());
      // fetch keeps connections alive; close them rather than wait them out.
      server.closeAllConnections();
    }),
);

/** Serves `latch` with a host 404 behind it; `before` plays a body parser. */
async function serve(
  handler: (req: Request) => Promise<Response | undefined>,
  before?: (req: IncomingMessage) => Promise<void>,
): Promise<string> {
  const latch = toNodeHandler(handler);
  server = createServer(async (req, res) => {
    await before?.(req);
    if (!(await latch(req, res))) {
      res.statusCode = 404;
      res.end("host 404");
    }
  });
  await new Promise<void>((ready) => server!.listen(0, ready));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe("toNodeHandler", () => {
  it("passes the request through and streams the answer back", async () => {
    let seen: { method: string; url: string; body: string; user: string | null } | undefined;
    const url = await serve(async (req) => {
      seen = { method: req.method, url: req.url, body: await req.text(), user: req.headers.get("x-user") };
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("data: one\n\n"));
          c.enqueue(new TextEncoder().encode("data: two\n\n"));
          c.close();
        },
      });
      return new Response(stream, { status: 201, headers: { "content-type": "text/event-stream" } });
    });

    const res = await fetch(`${url}/agents/a/c1?x=1`, { method: "POST", body: '{"text":"hi"}', headers: { "x-user": "u1" } });

    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe("data: one\n\ndata: two\n\n");
    expect(seen).toEqual({ method: "POST", url: `${url}/agents/a/c1?x=1`, body: '{"text":"hi"}', user: "u1" });
  });

  it("lets the host answer routes Latch doesn't own", async () => {
    const url = await serve(async () => undefined);
    const res = await fetch(`${url}/elsewhere`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("host 404");
  });

  it("keeps several cookies apart", async () => {
    const url = await serve(async () => {
      const headers = new Headers();
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      return new Response(null, { status: 302, headers });
    });
    const res = await fetch(url, { redirect: "manual" });
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("uses the parsed body when a body parser read the stream first", async () => {
    let body: string | undefined;
    const url = await serve(
      async (req) => {
        body = await req.text();
        return new Response(null, { status: 204 });
      },
      // What express.json() does: read the stream, leave the result on req.body.
      async (req) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        (req as IncomingMessage & { body?: unknown }).body = JSON.parse(raw);
      },
    );
    await fetch(url, { method: "POST", body: '{"text":"hi"}', headers: { "content-type": "application/json" } });
    expect(body).toBe('{"text":"hi"}');
  });

  it("survives a client that leaves mid-answer", async () => {
    let cancelled = false;
    const url = await serve(async () => {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("data: first\n\n"));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    });
    const ac = new AbortController();
    const res = await fetch(url, { signal: ac.signal });
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await new Promise((r) => setTimeout(r, 50));
    // The process is still up and the source was closed, not left hanging.
    expect(cancelled).toBe(true);
    expect((await fetch(`${url}/again`)).status).toBe(200);
  });
});
