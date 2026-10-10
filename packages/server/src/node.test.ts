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
const failures: unknown[] = [];

async function serve(
  handler: (req: Request) => Promise<Response | undefined>,
  before?: (req: IncomingMessage) => Promise<unknown>,
): Promise<string> {
  const latch = toNodeHandler(handler);
  failures.length = 0;
  server = createServer(async (req, res) => {
    // `before` plays a framework's body parser; what it returns is passed on
    // the way Fastify's `request.body` would be.
    const parsed = await before?.(req);
    try {
      if (!(await latch(req, res, parsed))) {
        res.statusCode = 404;
        res.end("host 404");
      }
    } catch (e) {
      failures.push(e);
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
    // The process is still up, the source was closed, and leaving isn't a failure.
    expect(cancelled).toBe(true);
    expect(failures).toHaveLength(0);
    expect((await fetch(`${url}/again`)).status).toBe(200);
  });

  it("sends a parsed form on as a form, not as JSON", async () => {
    let seen: { type: string | null; body: string } | undefined;
    const url = await serve(
      async (req) => {
        seen = { type: req.headers.get("content-type"), body: await req.text() };
        return new Response(null, { status: 204 });
      },
      // What express.urlencoded() does.
      async (req) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        (req as IncomingMessage & { body?: unknown }).body = Object.fromEntries(new URLSearchParams(raw));
      },
    );
    await fetch(url, { method: "POST", body: "a=1&b=two", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(seen).toEqual({ type: "application/x-www-form-urlencoded", body: "a=1&b=two" });
  });

  it("takes a body the framework parsed, passed in (Fastify's request.body)", async () => {
    let body: string | undefined;
    const url = await serve(
      async (req) => {
        body = await req.text();
        return new Response(null, { status: 204 });
      },
      async (req) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        return JSON.parse(raw); // not on req.body: Fastify keeps it on its own request
      },
    );
    await fetch(url, { method: "POST", body: '{"text":"hi"}', headers: { "content-type": "application/json" } });
    expect(body).toBe('{"text":"hi"}');
  });

  it("uses the first forwarded protocol", async () => {
    let seenUrl: string | undefined;
    const url = await serve(async (req) => {
      seenUrl = req.url;
      return new Response(null, { status: 204 });
    });
    await fetch(`${url}/x`, { headers: { "x-forwarded-proto": "https,http" } });
    expect(seenUrl?.startsWith("https://")).toBe(true);
  });

  it("rejects when the answer's own stream fails partway", async () => {
    const url = await serve(async () => {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("data: first\n\n"));
          c.error(new Error("model stream broke"));
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    });
    await fetch(url)
      .then((r) => r.text())
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toMatch(/model stream broke/);
  });
});
