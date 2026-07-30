import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPinnedFetch,
  type BaseLookup,
  type PinnedFetch,
} from "./pinned-fetch.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

type Addr = { address: string; family: number };
const A = (address: string, family = 4): Addr => ({ address, family });

/** Lookup backed by a (mutable) table — no real DNS in any test. */
function tableLookup(table: Record<string, Addr[]>): BaseLookup {
  return (hostname, _options, cb) => {
    const addrs = table[hostname];
    if (!addrs) {
      cb(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }));
      return;
    }
    cb(null, addrs);
  };
}

/** Flatten an error's cause chain (incl. AggregateError members) for matching. */
function causeChain(err: unknown): string {
  const parts: string[] = [];
  const walk = (e: unknown): void => {
    if (!e) return;
    if (e instanceof AggregateError) e.errors.forEach(walk);
    if (e instanceof Error) {
      parts.push(`${(e as NodeJS.ErrnoException).code ?? ""}:${e.message}`);
      walk(e.cause);
    } else {
      parts.push(String(e));
    }
  };
  walk(err);
  return parts.join(" <- ");
}

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return causeChain(err);
  }
  throw new Error("expected the fetch to reject");
}

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function pinned(...args: Parameters<typeof createPinnedFetch>): PinnedFetch {
  const pf = createPinnedFetch(...args);
  cleanups.push(() => pf.close());
  return pf;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return (server.address() as AddressInfo).port;
}

describe("vetting at connect time", () => {
  it("blocks a hostname that resolves to a private address", async () => {
    const pf = pinned({ lookup: tableLookup({ "api.example": [A("169.254.169.254")] }) });
    expect(await rejection(pf("http://api.example/"))).toMatch(
      /Blocked private\/internal address: api\.example -> 169\.254\.169\.254/,
    );
  });

  it("blocks when ANY resolved address is private (multi-answer)", async () => {
    const pf = pinned({
      lookup: tableLookup({
        "api.example": [A("93.184.216.34"), A("10.0.0.7")],
      }),
    });
    expect(await rejection(pf("http://api.example/"))).toMatch(/10\.0\.0\.7/);
  });

  it("blocks private IPv6 answers and fails closed on unparseable resolver output", async () => {
    const v6 = pinned({ lookup: tableLookup({ "api.example": [A("fd00::1", 6)] }) });
    expect(await rejection(v6("http://api.example/"))).toMatch(/fd00::1/);
    const junk = pinned({ lookup: tableLookup({ "api.example": [A("not-an-ip", 6)] }) });
    expect(await rejection(junk("http://api.example/"))).toMatch(/Blocked/);
  });

  it("fails closed on lookup error and on empty answers", async () => {
    const pf = pinned({ lookup: tableLookup({ "empty.example": [] }) });
    expect(await rejection(pf("http://missing.example/"))).toMatch(/ENOTFOUND/);
    expect(await rejection(pf("http://empty.example/"))).toMatch(
      /lookup returned no addresses/,
    );
  });

  it("defeats rebinding: public at validation time, private at connect time", async () => {
    const table: Record<string, Addr[]> = { "rebind.example": [A("93.184.216.34")] };
    const lookup = tableLookup(table);
    // Validation-style pre-check on the same resolver sees a public address...
    const vetted = await new Promise<Addr[]>((resolve, reject) =>
      lookup("rebind.example", { all: true }, (e, a) => (e ? reject(e) : resolve(a!))),
    );
    expect(vetted).toEqual([A("93.184.216.34")]);
    // ...then the attacker flips the record before the request opens.
    table["rebind.example"] = [A("127.0.0.1")];
    const pf = pinned({ lookup });
    expect(await rejection(pf("http://rebind.example/"))).toMatch(
      /Blocked private\/internal address: rebind\.example -> 127\.0\.0\.1/,
    );
  });

  it("vets IP-literal hosts in the connector (no lookup involved)", async () => {
    const pf = pinned(); // real dns lookup — never reached for literals
    // High port: the connector rejects before connecting, nothing listens there.
    expect(await rejection(pf("http://127.0.0.1:59999/"))).toMatch(
      /Blocked private\/internal address: 127\.0\.0\.1/,
    );
    expect(await rejection(pf("http://[::1]:59999/"))).toMatch(
      /Blocked private\/internal address: ::1/,
    );
  });
});

describe("plumbing", () => {
  it("connects to the resolved address while preserving the Host header", async () => {
    let seenHost: string | undefined;
    const server = createHttpServer((req, res) => {
      seenHost = req.headers.host;
      res.end("ok");
    });
    const port = await listen(server);
    const pf = pinned({
      allowPrivate: true,
      lookup: tableLookup({ "pinned-test.example": [A("127.0.0.1")] }),
    });
    const res = await pf(`http://pinned-test.example:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(seenHost).toBe(`pinned-test.example:${port}`);
  });

  it("supports the scalar lookup-callback shape (autoSelectFamily off)", async () => {
    const server = createHttpServer((_req, res) => res.end("ok"));
    const port = await listen(server);
    const pf = pinned({
      allowPrivate: true,
      lookup: tableLookup({ "pinned-test.example": [A("127.0.0.1")] }),
      connect: { autoSelectFamily: false },
    });
    const res = await pf(`http://pinned-test.example:${port}/`);
    expect(res.status).toBe(200);
  });

  it("still vets when autoSelectFamily is off", async () => {
    const pf = pinned({
      lookup: tableLookup({ "api.example": [A("192.168.1.5")] }),
      connect: { autoSelectFamily: false },
    });
    expect(await rejection(pf("http://api.example/"))).toMatch(/192\.168\.1\.5/);
  });
});

describe("TLS validates against the original hostname", () => {
  const tlsServer = () =>
    createHttpsServer(
      { key: fixture("server.key"), cert: fixture("server.pem") },
      (_req, res) => res.end("secure"),
    );

  it("succeeds when the cert matches the URL hostname", async () => {
    const port = await listen(tlsServer());
    const pf = pinned({
      allowPrivate: true,
      lookup: tableLookup({ "pinned-test.example": [A("127.0.0.1")] }),
      connect: { ca: fixture("ca.pem") },
    });
    const res = await pf(`https://pinned-test.example:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("secure");
  });

  it("rejects a cert that does not match the URL hostname", async () => {
    const port = await listen(tlsServer());
    const pf = pinned({
      allowPrivate: true,
      // Same pinned address — only the requested name differs from the cert.
      lookup: tableLookup({ "wrong-name.example": [A("127.0.0.1")] }),
      connect: { ca: fixture("ca.pem") },
    });
    expect(await rejection(pf(`https://wrong-name.example:${port}/`))).toMatch(
      /ERR_TLS_CERT_ALTNAME_INVALID/,
    );
  });

  it("rejects an untrusted chain (rejectUnauthorized untouched)", async () => {
    const port = await listen(tlsServer());
    const pf = pinned({
      allowPrivate: true,
      lookup: tableLookup({ "pinned-test.example": [A("127.0.0.1")] }),
      // No `ca` — the fixture CA must NOT be trusted by default.
    });
    expect(await rejection(pf(`https://pinned-test.example:${port}/`))).toMatch(
      /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED|unable to (verify|get)/i,
    );
  });
});
