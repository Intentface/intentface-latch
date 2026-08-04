import type { Vault } from "@intentface/latch-core";
import type * as latchNet from "@intentface/latch-net";
import { describe, expect, it, vi } from "vitest";
import { createConnectionStore } from "./connection-store";
import { upsertConnection, normalizeConnectionName } from "./connection-upsert";
import type { ConnectionInput } from "./connection-upsert";
import type { DynamicConnections } from "./dynamic-connections";
import type { Principal } from "./session";

// Fake hostnames don't resolve; the DNS backstop fails closed and would reject
// every URL here. The string-level SSRF checks (scheme, private literals) stay
// real — those are what these tests assert.
vi.mock("@intentface/latch-net", async (importOriginal) => {
  const actual = await importOriginal<typeof latchNet>();
  return { ...actual, isBlockedResolved: async () => false };
});

function memoryVault(): Vault<Principal> {
  const data = new Map<string, string>();
  const k = (p: Principal, key: string) => `${p.orgId}/${p.userId ?? ""}:${key}`;
  return {
    set: async (p: Principal, key: string, value: string) => void data.set(k(p, key), value),
    get: async (p: Principal, key: string) => data.get(k(p, key)),
    has: async (p: Principal, key: string) => data.has(k(p, key)),
    delete: async (p: Principal, key: string) => void data.delete(k(p, key)),
    list: async (p: Principal) =>
      [...data.keys()]
        .filter((key) => key.startsWith(`${p.orgId}/${p.userId ?? ""}:`))
        .map((key) => key.slice(`${p.orgId}/${p.userId ?? ""}:`.length)),
    resolver: { get: async () => undefined },
  } as unknown as Vault<Principal>;
}

const principal: Principal = { orgId: "org1", userId: "alice" };

/** Records `invalidateCredentials` calls so the scope-change rule is observable. */
function harness() {
  const store = createConnectionStore(memoryVault());
  const invalidated: string[] = [];
  const dynamic = {
    oauth: (name: string) => ({
      provider: () => ({
        invalidateCredentials: async (scope: string) => {
          invalidated.push(`${name}:${scope}`);
        },
      }),
    }),
  } as unknown as DynamicConnections;
  const run = (input: ConnectionInput) =>
    upsertConnection(principal, input, { connectionStore: store, dynamic });
  return { store, dynamic, invalidated, run };
}

const OAUTH2: ConnectionInput = {
  name: "strava",
  kind: "openapi",
  scope: "user",
  spec: "https://specs.example.com/strava.json",
  authMode: "oauth2",
  authorizeUrl: "https://auth.example.com/authorize",
  tokenUrl: "https://auth.example.com/token",
  clientId: "268672",
  clientSecret: "s3cret",
  scopes: "read activity:read",
};

describe("normalizeConnectionName", () => {
  it("reduces a name to the tool-source alphabet", () => {
    expect(normalizeConnectionName("  My Strava! ")).toBe("My_Strava_");
    expect(normalizeConnectionName("google-drive_2")).toBe("google-drive_2");
  });
});

describe("upsertConnection", () => {
  it("stores an oauth2 OpenAPI connection with its client credentials", async () => {
    const { store, run } = harness();
    expect(await run(OAUTH2)).toEqual({ ok: true, name: "strava" });
    const saved = await store.get(principal, "strava");
    expect(saved?.auth).toEqual({
      kind: "oauth2",
      authorizeUrl: "https://auth.example.com/authorize",
      tokenUrl: "https://auth.example.com/token",
      clientId: "268672",
      clientSecret: "s3cret",
      scopes: ["read", "activity:read"],
    });
  });

  it("rejects oauth2 on an MCP connection", async () => {
    const { run } = harness();
    const res = await run({ ...OAUTH2, kind: "mcp", url: "https://mcp.example.com", spec: undefined });
    expect(res).toEqual({ ok: false, error: "oauth2 is supported for OpenAPI connections only" });
  });

  it("rejects oauth (discovery) on an OpenAPI connection", async () => {
    // Without an explicit rejection this fell through to the static-token
    // branch, found no token, and saved with NO auth — a connection that looks
    // configured but is silently unauthenticated.
    const { store, run } = harness();
    const res = await run({
      name: "silent",
      kind: "openapi",
      scope: "user",
      spec: "https://specs.example.com/x.json",
      authMode: "oauth",
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("MCP connections only");
    expect(await store.get(principal, "silent")).toBeUndefined();
  });

  it("requires all four oauth2 fields", async () => {
    const { run } = harness();
    for (const missing of ["authorizeUrl", "tokenUrl", "clientId", "clientSecret"] as const) {
      const res = await run({ ...OAUTH2, [missing]: undefined });
      expect(res).toEqual({
        ok: false,
        error: "oauth2 requires authorize URL, token URL, client ID and client secret",
      });
    }
  });

  it("refuses a non-https or private oauth2 endpoint", async () => {
    const { run } = harness();
    const insecure = await run({ ...OAUTH2, tokenUrl: "http://auth.example.com/token" });
    expect(insecure.ok).toBe(false);
    const loopback = await run({ ...OAUTH2, authorizeUrl: "https://127.0.0.1/authorize" });
    expect(loopback.ok).toBe(false);
  });

  it("keeps the stored client secret when the field is blank on edit", async () => {
    // The Agent Builder omits clientSecretRef to mean "don't rotate", exactly as
    // the edit form leaves the password input empty.
    const { store, run } = harness();
    await run(OAUTH2);
    expect(await run({ ...OAUTH2, clientSecret: undefined, clientId: "999" })).toMatchObject({
      ok: true,
    });
    const saved = await store.get(principal, "strava");
    expect(saved?.auth).toMatchObject({ clientId: "999", clientSecret: "s3cret" });
  });

  it("keeps the stored static token when the field is blank on edit", async () => {
    const { store, run } = harness();
    const base: ConnectionInput = {
      name: "notes",
      kind: "mcp",
      scope: "user",
      url: "https://mcp.example.com",
      authMode: "token",
      token: "tok-1",
    };
    await run(base);
    await run({ ...base, token: undefined });
    expect(await store.get(principal, "notes")).toMatchObject({
      auth: { kind: "bearer", token: "tok-1" },
    });
  });

  it("clears auth when the mode is explicitly none, even with a token present", async () => {
    const { store, run } = harness();
    const base: ConnectionInput = {
      name: "open",
      kind: "mcp",
      scope: "user",
      url: "https://mcp.example.com",
      authMode: "token",
      token: "tok",
    };
    await run(base);
    await run({ ...base, authMode: "none" });
    expect((await store.get(principal, "open"))?.auth).toBeUndefined();
  });

  it("uses a custom header when one is given", async () => {
    const { store, run } = harness();
    await run({
      name: "clockify",
      kind: "openapi",
      scope: "user",
      spec: "https://specs.example.com/clockify.json",
      authMode: "token",
      authHeader: "X-Api-Key",
      token: "abc",
    });
    expect((await store.get(principal, "clockify"))?.auth).toEqual({
      kind: "header",
      header: "X-Api-Key",
      token: "abc",
    });
  });

  it("forces re-consent when MCP oauth scopes change, but not when they are reordered", async () => {
    const { invalidated, run } = harness();
    const base: ConnectionInput = {
      name: "drive",
      kind: "mcp",
      scope: "user",
      url: "https://mcp.example.com",
      authMode: "oauth",
      scopes: "read write",
    };
    await run(base);
    invalidated.length = 0;

    // Same set, different order → the grant must survive.
    await run({ ...base, scopes: "write read" });
    expect(invalidated).toEqual([]);

    // A genuinely different set → the old token is no longer accurate.
    await run({ ...base, scopes: "read" });
    expect(invalidated).toEqual(["drive:all"]);
  });

  it("requires the kind's own target field", async () => {
    const { run } = harness();
    expect(await run({ name: "a", kind: "mcp", scope: "user" })).toEqual({
      ok: false,
      error: "url required",
    });
    expect(await run({ name: "b", kind: "openapi", scope: "user" })).toEqual({
      ok: false,
      error: "spec required",
    });
  });

  it("rejects a name that sanitises to nothing", async () => {
    const { run } = harness();
    expect(await run({ name: "  ", kind: "mcp", scope: "user", url: "https://x.example.com" })).toEqual({
      ok: false,
      error: "name required",
    });
  });

  it("upserts by (name, scope) rather than creating duplicates", async () => {
    const { store, run } = harness();
    await run({ name: "dup", kind: "mcp", scope: "user", url: "https://one.example.com" });
    await run({ name: "dup", kind: "mcp", scope: "user", url: "https://two.example.com" });
    const all = await store.list(principal);
    expect(all.filter((c) => c.name === "dup")).toHaveLength(1);
    expect(all.find((c) => c.name === "dup")?.mcp?.url).toBe("https://two.example.com");
  });
});
