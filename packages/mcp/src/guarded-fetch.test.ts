/**
 * The fetch behind every MCP request — transport and OAuth alike.
 *
 * What is asserted here is the difference between "we checked the hostname"
 * and "we connected to the address we checked": the vetting happens inside the
 * lookup the socket itself uses, so a name cannot answer public to the check
 * and private to the connect. Plus the two things this wrapper adds on top of
 * the pinned fetch — redirects refused, and a `Request` unpacked rather than
 * handed to undici, which rejects one built by another fetch implementation.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createGuardedFetch, type GuardedFetch } from "./guarded-fetch.js";

type Addr = { address: string; family: number };
const A = (address: string, family = 4): Addr => ({ address, family });

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function guarded(...args: Parameters<typeof createGuardedFetch>): GuardedFetch {
  const f = createGuardedFetch(...args);
  cleanups.push(() => f.close());
  return f;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return (server.address() as AddressInfo).port;
}

/** A lookup backed by a mutable table — no real DNS in any test. */
const tableLookup =
  (table: Record<string, Addr[]>) =>
  (
    hostname: string,
    _options: unknown,
    cb: (err: NodeJS.ErrnoException | null, addrs?: Addr[]) => void,
  ): void => {
    const addrs = table[hostname];
    if (!addrs) return cb(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }));
    cb(null, addrs);
  };

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const parts: string[] = [];
    const walk = (e: unknown): void => {
      if (!e) return;
      if (e instanceof AggregateError) e.errors.forEach(walk);
      if (e instanceof Error) {
        parts.push(e.message);
        walk(e.cause);
      }
    };
    walk(err);
    return parts.join(" <- ");
  }
  throw new Error("expected the fetch to reject");
}

describe("address vetting", () => {
  it("refuses a name that resolves to an internal address", async () => {
    // The cloud metadata endpoint, reached through a name the MCP server's
    // metadata could perfectly well have pointed at.
    const f = guarded({
      lookup: tableLookup({ "auth.evil.example": [A("169.254.169.254")] }) as never,
    });
    expect(await rejection(f("http://auth.evil.example/.well-known/openid-configuration"))).toMatch(
      /Blocked private\/internal address: auth\.evil\.example -> 169\.254\.169\.254/,
    );
  });

  it("refuses a name that answers public first and private when the socket opens", async () => {
    // DNS rebinding: the open-time check would pass, the connect would land
    // inside. The vetting is in the lookup the socket uses, so there is no gap.
    const table: Record<string, Addr[]> = { "rebind.example": [A("93.184.216.34")] };
    const f = guarded({ lookup: tableLookup(table) as never });
    table["rebind.example"] = [A("127.0.0.1")];
    expect(await rejection(f("http://rebind.example/mcp"))).toMatch(
      /Blocked private\/internal address: rebind\.example -> 127\.0\.0\.1/,
    );
  });

  it("permits a loopback server when the connection opted in", async () => {
    // A developer's `http://localhost:3999/mcp`, and an in-cluster server.
    const port = await listen(
      createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      }),
    );
    const f = guarded({ allowPrivateHost: true });
    const res = await f(`http://127.0.0.1:${port}/mcp`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("what the wrapper adds", () => {
  it("refuses to follow a redirect, even when the caller asks for one", async () => {
    // A 302 names an address nothing vetted; no MCP or OAuth leg needs one.
    const port = await listen(
      createServer((_req, res) => {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
      }),
    );
    const f = guarded({ allowPrivateHost: true });
    expect(
      await rejection(f(`http://127.0.0.1:${port}/`, { redirect: "follow" })),
    ).toMatch(/redirect/i);
  });

  it("carries the Request's abort signal, so a cancelled call releases its socket", async () => {
    // Without this the reconstruction drops `signal` and an aborted MCP or
    // OAuth call keeps its socket until the server finally answers.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    cleanups.push(() => release());
    const port = await listen(
      createServer(async (_req, res) => {
        await held; // never answers until the test lets it
        res.writeHead(200);
        res.end("late");
      }),
    );
    const f = guarded({ allowPrivateHost: true });
    const controller = new AbortController();
    const inflight = f(
      new Request(`http://127.0.0.1:${port}/slow`, { signal: controller.signal }),
    );
    controller.abort();
    expect(await rejection(inflight)).toMatch(/abort/i);
  });

  it("an explicit init signal replaces the Request's", async () => {
    const port = await listen(
      createServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
      }),
    );
    const f = guarded({ allowPrivateHost: true });
    const requestSide = new AbortController();
    requestSide.abort(); // already aborted — must NOT decide the outcome
    const res = await f(new Request(`http://127.0.0.1:${port}/`, { signal: requestSide.signal }), {
      signal: new AbortController().signal,
    });
    expect(res.status).toBe(200);
  });

  it("unpacks a Request rather than handing it to undici", async () => {
    // undici rejects a Request built by another fetch implementation
    // (cross-realm brand check), so a caller passing one must not silently
    // bypass the guard — method, headers and body have to survive.
    let seen: { method?: string; auth?: string; body?: string } = {};
    const port = await listen(
      createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          seen = { method: req.method, auth: req.headers.authorization, body };
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"ok":true}');
        });
      }),
    );
    const f = guarded({ allowPrivateHost: true });
    const res = await f(
      new Request(`http://127.0.0.1:${port}/token`, {
        method: "POST",
        headers: { authorization: "Bearer t0ken", "content-type": "application/json" },
        body: '{"grant_type":"authorization_code"}',
      }),
    );
    expect(res.status).toBe(200);
    expect(seen.method).toBe("POST");
    expect(seen.auth).toBe("Bearer t0ken");
    expect(seen.body).toBe('{"grant_type":"authorization_code"}');
  });
});
