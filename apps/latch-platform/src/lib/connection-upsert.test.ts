import type { Vault } from "@intentface/latch-core";
import type * as latchNet from "@intentface/latch-net";
import { describe, expect, it, vi } from "vitest";
import { createConnectionStore } from "./connection-store";
import { upsertConnection, normalizeConnectionName } from "./connection-upsert";
import type { ConnectionInput } from "./connection-upsert";
import type { DynamicConnections } from "./dynamic-connections";
import { createNamedSecrets } from "./named-secrets";
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
  // One vault for both, as in production — a connection's ref and the secret it
  // names have to live in the same store for resolution to mean anything.
  const vault = memoryVault();
  const store = createConnectionStore(vault);
  const namedSecrets = createNamedSecrets(vault);
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
    upsertConnection(principal, input, { connectionStore: store, dynamic, namedSecrets });
  return { store, dynamic, namedSecrets, invalidated, run };
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
  it("mints a named secret from a typed client secret and stores only the name", async () => {
    const { store, namedSecrets, run } = harness();
    expect(await run(OAUTH2)).toEqual({ ok: true, name: "strava" });
    const saved = await store.get(principal, "strava");
    expect(saved?.auth).toEqual({
      kind: "oauth2",
      authorizeUrl: "https://auth.example.com/authorize",
      tokenUrl: "https://auth.example.com/token",
      clientId: "268672",
      clientSecretRef: "strava_client_secret",
      clientSecret: undefined,
      scopes: ["read", "activity:read"],
    });
    // The value is in the Vault, reachable by name — and nowhere in the record.
    expect(await namedSecrets.get(principal, "strava_client_secret", "user")).toBe("s3cret");
    expect(JSON.stringify(saved)).not.toContain("s3cret");
  });

  it("mints a named secret from a typed static token", async () => {
    const { store, namedSecrets, run } = harness();
    await run({
      name: "notes",
      kind: "mcp",
      scope: "user",
      url: "https://mcp.example.com",
      authMode: "token",
      token: "tok-1",
    });
    expect((await store.get(principal, "notes"))?.auth).toEqual({
      kind: "bearer",
      header: undefined,
      token: undefined,
      tokenRef: "notes_token",
    });
    expect(await namedSecrets.get(principal, "notes_token", "user")).toBe("tok-1");
  });

  it("rotates the secret in place when a value is retyped", async () => {
    // The point of references: one write reaches every connection built on the
    // secret, instead of each one holding its own stale copy.
    const { store, namedSecrets, run } = harness();
    await run(OAUTH2);
    await run({ ...OAUTH2, clientSecret: "rotated" });
    expect(await namedSecrets.get(principal, "strava_client_secret", "user")).toBe("rotated");
    // Still one secret, still the same name — no `-2` sprouted.
    expect(await namedSecrets.list(principal)).toEqual([
      { name: "strava_client_secret", scope: "user" },
    ]);
    expect((await store.get(principal, "strava"))?.auth).toMatchObject({
      clientSecretRef: "strava_client_secret",
    });
  });

  it("never overwrites a secret that belongs to something else", async () => {
    // The derived name is taken by an unrelated secret, so this connection gets
    // its own rather than silently rotating someone else's credential.
    const { store, namedSecrets, run } = harness();
    await namedSecrets.set(principal, "strava_client_secret", "user", "someone-elses");
    await run(OAUTH2);
    expect((await store.get(principal, "strava"))?.auth).toMatchObject({
      clientSecretRef: "strava_client_secret-2",
    });
    expect(await namedSecrets.get(principal, "strava_client_secret", "user")).toBe("someone-elses");
    expect(await namedSecrets.get(principal, "strava_client_secret-2", "user")).toBe("s3cret");
  });

  it("accepts a ref the agent supplies and stores no value", async () => {
    const { store, run, namedSecrets } = harness();
    await namedSecrets.set(principal, "shared_oauth_secret", "user", "from-the-form");
    await run({ ...OAUTH2, clientSecret: undefined, clientSecretRef: "shared_oauth_secret" });
    expect((await store.get(principal, "strava"))?.auth).toMatchObject({
      clientSecretRef: "shared_oauth_secret",
    });
  });

  it("rejects a ref that does not exist, and one stored at the other scope", async () => {
    const { run, namedSecrets } = harness();
    const missing = await run({ ...OAUTH2, clientSecret: undefined, clientSecretRef: "nope" });
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.error).toContain('No stored secret named "nope"');

    // Strict scope match, both directions: an org secret must not back a
    // personal connection, nor a personal one an org-shared connection.
    await namedSecrets.set(principal, "org_secret", "org", "v");
    const crossScope = await run({
      ...OAUTH2,
      clientSecret: undefined,
      clientSecretRef: "org_secret",
    });
    expect(crossScope.ok).toBe(false);
    expect(crossScope.ok === false && crossScope.error).toContain("stored at org scope");
  });

  it("does not mint a secret when a later validation fails", async () => {
    // Settling a credential WRITES to the vault, so the shape checks have to run
    // first or a rejected save leaves an orphan behind.
    const { namedSecrets, run } = harness();
    expect(await run({ ...OAUTH2, spec: undefined })).toEqual({ ok: false, error: "spec required" });
    expect(await namedSecrets.list(principal)).toEqual([]);
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
    expect(saved?.auth).toMatchObject({
      clientId: "999",
      clientSecretRef: "strava_client_secret",
    });
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
      auth: { kind: "bearer", tokenRef: "notes_token" },
    });
  });

  it("leaves a legacy inline secret alone until it is retyped", async () => {
    // Records written before references existed must keep working untouched —
    // no migration script, no forced re-entry. Retyping is what migrates them.
    const { store, namedSecrets, run } = harness();
    await store.add(principal, "user", {
      kind: "mcp",
      name: "legacy",
      mcp: { url: "https://mcp.example.com" },
      auth: { kind: "bearer", token: "inline-tok" },
    });
    const base: ConnectionInput = {
      name: "legacy",
      kind: "mcp",
      scope: "user",
      url: "https://mcp.example.com",
      authMode: "token",
    };

    // Edit something else: the inline value survives, still un-referenced.
    await run({ ...base, authHeader: "X-Api-Key" });
    expect((await store.get(principal, "legacy"))?.auth).toMatchObject({
      kind: "header",
      token: "inline-tok",
    });
    expect(await namedSecrets.list(principal)).toEqual([]);

    // Retype it: now it becomes a reference, and the inline copy is gone.
    await run({ ...base, token: "typed-again" });
    expect((await store.get(principal, "legacy"))?.auth).toEqual({
      kind: "bearer",
      header: undefined,
      token: undefined,
      tokenRef: "legacy_token",
    });
    expect(await namedSecrets.get(principal, "legacy_token", "user")).toBe("typed-again");
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
      token: undefined,
      tokenRef: "clockify_token",
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
