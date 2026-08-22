import type { Vault } from "@intentface/latch-core";
import type * as latchNet from "@intentface/latch-net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectionStore } from "./connection-store";
import { createDynamicConnections } from "./dynamic-connections";
import { createNamedSecrets } from "./named-secrets";
import { oauth2ConfigFingerprint } from "./oauth2-flow";
import type { Principal } from "./session";

// Fake hostnames don't resolve; the DNS backstop fails closed and would block
// both the OpenAPI spec fetch and the token endpoint. String-level checks stay real.
vi.mock("@intentface/latch-net", async (importOriginal) => {
  const actual = await importOriginal<typeof latchNet>();
  return { ...actual, isBlockedResolved: async () => false };
});

// The DNS-pinned fetch would vet fake hostnames at connect time (real
// network); route it to the stubbed global so tests stay hermetic. A spy, not
// a plain alias: asserting it was called is what catches an accidental revert
// to global `fetch` (which these mocks would otherwise mask).
const pinnedFetchMock = vi.hoisted(() =>
  vi.fn((input: string | URL, init?: RequestInit) => globalThis.fetch(input, init)),
);
vi.mock("@intentface/latch-net/pinned", () => ({
  pinnedFetch: pinnedFetchMock,
  createPinnedFetch: () =>
    Object.assign(
      (input: string | URL, init?: RequestInit) => globalThis.fetch(input, init),
      { close: async () => {} },
    ),
}));

/** In-memory Vault stub — enough surface for the store + OAuth flows. */
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

const principal: Principal = { orgId: "org1", userId: "user1" };

const SPEC_URL = "https://specs.example.com/strava.json";
const API_BASE = "https://api.example.com";
const SPEC = {
  openapi: "3.0.0",
  info: { title: "Strava-ish", version: "1" },
  servers: [{ url: API_BASE }],
  paths: {
    "/athlete": {
      get: {
        operationId: "getAthlete",
        summary: "The authenticated athlete",
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Routes the OpenAPI spec, the API itself and the IdP token endpoint. */
function stubFetch() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === SPEC_URL) return json(SPEC);
    if (url.startsWith(`${API_BASE}/athlete`)) return json({ id: 42 });
    if (url === "https://idp.example.com/oauth/token")
      return json({ access_token: "at-new", expires_in: 3600, refresh_token: "rt-new" });
    return json({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", mock);
  return calls;
}

/**
 * `clientSecretRef` picks the credential shape under test: omitted gives the
 * legacy INLINE record (what every connection written before references looks
 * like), a name gives the referenced one.
 */
async function setup(opts: { clientSecretRef?: string } = {}) {
  const vault = memoryVault();
  const store = createConnectionStore(vault);
  const secrets = createNamedSecrets(vault);
  if (opts.clientSecretRef) await secrets.set(principal, opts.clientSecretRef, "user", "sec-1");
  await store.add(principal, "user", {
    kind: "openapi",
    name: "strava",
    openapi: { spec: SPEC_URL, baseUrl: API_BASE },
    auth: {
      kind: "oauth2",
      authorizeUrl: "https://idp.example.com/oauth/authorize",
      tokenUrl: "https://idp.example.com/oauth/token",
      clientId: "cid-1",
      clientSecret: opts.clientSecretRef ? undefined : "sec-1",
      clientSecretRef: opts.clientSecretRef,
      scopes: ["read"],
    },
  });
  const dynamic = createDynamicConnections({
    store,
    secrets,
    vault,
    callbackBaseUrl: "http://localhost:3000/api/latch/connections",
  });
  // Mirror the config the registry's resolver produces (auth + target folded
  // into the fingerprint) so the seeded grant matches the live connection.
  // Pointing at the connection's OWN secret name contributes nothing, which is
  // what keeps inline and migrated records on the same grant.
  const cfg = oauth2ConfigFingerprint({
    authorizeUrl: "https://idp.example.com/oauth/authorize",
    tokenUrl: "https://idp.example.com/oauth/token",
    clientId: "cid-1",
    clientSecret: "sec-1",
    scopes: ["read"],
    fingerprint: JSON.stringify(
      opts.clientSecretRef && opts.clientSecretRef !== "strava_client_secret"
        ? [SPEC_URL, API_BASE, opts.clientSecretRef]
        : [SPEC_URL, API_BASE],
    ),
  });
  const authorize = () =>
    vault.set(
      principal,
      "oauth2:strava:tokens",
      JSON.stringify({
        access_token: "at-live",
        refresh_token: "rt-live",
        expires_at: Date.now() + 3_600_000,
        cfg,
      }),
    );
  return { vault, store, secrets, dynamic, authorize };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dynamic oauth2 OpenAPI connections", () => {
  it("unauthorized: only the gated connect tool is exposed", async () => {
    stubFetch();
    const { dynamic } = await setup();
    const opened = await dynamic.hostFor(["strava"]).open(principal);
    expect(Object.keys(opened.tools)).toEqual(["connect_strava"]);
    expect(opened.toolApproval).toMatchObject({ connect_strava: "user-approval" });
    expect(opened.alwaysActive).toContain("connect_strava");
    await opened.close();
  });

  it("a channel actor resolves grants under THEIR key — never the binding owner's", async () => {
    // Shared-thread turns keep the binding's userId for chat ownership and
    // carry the typist as actorUserId. The security property: the typist's own
    // grant unlocks the tools, and a typist WITHOUT a grant gets the connect
    // card even though the binding owner is fully connected — no riding
    // another member's OAuth tokens, in either direction.
    stubFetch();
    const vault = memoryVault();
    const store = createConnectionStore(vault);
    const secrets = createNamedSecrets(vault);
    const owner: Principal = { orgId: "org1", userId: "binder" };
    await store.add(owner, "org", {
      kind: "openapi",
      name: "strava",
      openapi: { spec: SPEC_URL, baseUrl: API_BASE },
      auth: {
        kind: "oauth2",
        authorizeUrl: "https://idp.example.com/oauth/authorize",
        tokenUrl: "https://idp.example.com/oauth/token",
        clientId: "cid-1",
        clientSecret: "sec-1",
        scopes: ["read"],
      },
    });
    const dynamic = createDynamicConnections({
      store,
      secrets,
      vault,
      callbackBaseUrl: "http://localhost:3000/api/latch/connections",
    });
    const cfg = oauth2ConfigFingerprint({
      authorizeUrl: "https://idp.example.com/oauth/authorize",
      tokenUrl: "https://idp.example.com/oauth/token",
      clientId: "cid-1",
      clientSecret: "sec-1",
      scopes: ["read"],
      fingerprint: JSON.stringify([SPEC_URL, API_BASE]),
    });
    // The BINDING OWNER has a grant; the actor "alice" does not (yet).
    await vault.set(
      owner,
      "oauth2:strava:tokens",
      JSON.stringify({ access_token: "at-owner", refresh_token: "rt", expires_at: Date.now() + 3_600_000, cfg }),
    );

    // Alice types in the channel: turn principal = binding + actor alice.
    const aliceTurn: Principal = { orgId: "org1", userId: "binder", actorUserId: "alice" };
    const before = await dynamic.hostFor(["strava"]).open(aliceTurn);
    expect(Object.keys(before.tools)).toEqual(["connect_strava"]); // owner's grant does NOT leak to alice
    expect(before.toolApproval).toMatchObject({ connect_strava: "user-approval" });
    await before.close();

    // Alice connects (grant under HER key), and the same turn principal unlocks.
    await vault.set(
      { orgId: "org1", userId: "alice" },
      "oauth2:strava:tokens",
      JSON.stringify({ access_token: "at-alice", refresh_token: "rt", expires_at: Date.now() + 3_600_000, cfg }),
    );
    const after = await dynamic.hostFor(["strava"]).open(aliceTurn);
    expect(Object.keys(after.tools).sort()).toEqual(["connect_strava", "strava_getAthlete"]);
    const tool = after.tools.strava_getAthlete as {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };
    await tool.execute({}, { toolCallId: "t1", messages: [], context: { principal: aliceTurn } });
    await after.close();
  });

  it("authorized: connect_<name> loses its approval gate and no-ops to {connected:true}", async () => {
    // A model primed by its own history ("I need to connect first…") may call
    // connect_* even though the connection is live. Gated, that parks a
    // sign-in card for a connection that's already connected — the Slack
    // dead-end. Ungated, the call executes, returns connected:true, and the
    // model course-corrects within the same turn.
    stubFetch();
    const { dynamic, authorize } = await setup();
    await authorize();
    const opened = await dynamic.hostFor(["strava"]).open(principal);
    expect(opened.toolApproval).not.toHaveProperty("connect_strava");
    const connect = opened.tools.connect_strava as {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };
    await expect(
      connect.execute({}, { toolCallId: "t1", messages: [], context: { principal } }),
    ).resolves.toEqual({ connected: true, connection: "strava" });
    await opened.close();
  });

  it("authorized: API tools appear and calls carry the brokered bearer token", async () => {
    const calls = stubFetch();
    const { dynamic, authorize } = await setup();
    await authorize();
    const opened = await dynamic.hostFor(["strava"]).open(principal);
    expect(Object.keys(opened.tools).sort()).toEqual(["connect_strava", "strava_getAthlete"]);

    const tool = opened.tools.strava_getAthlete as {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };
    const result = await tool.execute({}, { toolCallId: "t1", messages: [], context: { principal } });
    expect(result).toEqual({ id: 42 });
    const apiCall = calls.find((c) => c.url.startsWith(`${API_BASE}/athlete`))!;
    expect((apiCall.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer at-live",
    );
    // Wiring assertion: BOTH outbound boundaries must go through the
    // DNS-pinned fetch. Each is asserted separately — a dropped `fetch:`
    // option on either the spec download or the tool request falls back to
    // global fetch, which the mock aliases to, so every other assertion here
    // would still pass.
    const pinnedUrls = pinnedFetchMock.mock.calls.map(([input]) => String(input));
    expect(pinnedUrls).toContain(SPEC_URL);
    expect(pinnedUrls.some((u) => u.startsWith(`${API_BASE}/athlete`))).toBe(true);
    await opened.close();
  });

  it("a dead grant yields the API's own 401 as a tool result, not a crash", async () => {
    const calls = stubFetch();
    const { dynamic, authorize, vault } = await setup();
    await authorize();
    const opened = await dynamic.hostFor(["strava"]).open(principal);
    // Grant dies mid-turn (revoked elsewhere) — the flow can't produce a token.
    await vault.delete(principal, "oauth2:strava:tokens");
    const tool = opened.tools.strava_getAthlete as {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };
    const result = await tool.execute({}, { toolCallId: "t1", messages: [], context: { principal } });
    // No Authorization header was sent; our stub returns 200 regardless, so
    // just assert the call went out headerless and nothing threw.
    const apiCall = calls.find((c) => c.url.startsWith(`${API_BASE}/athlete`))!;
    expect((apiCall.init?.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(result).toEqual({ id: 42 });
    await opened.close();
  });

  it("status() reports the oauth2 connection with its authorization state", async () => {
    stubFetch();
    const { dynamic, authorize } = await setup();
    expect(await dynamic.status(principal)).toEqual([
      { name: "strava", oauth: true, authorized: false },
    ]);
    await authorize();
    expect(await dynamic.status(principal)).toEqual([
      { name: "strava", oauth: true, authorized: true },
    ]);
  });

  it("oauth(name) dispatches to the oauth2 flow for openapi connections", async () => {
    stubFetch();
    const { dynamic } = await setup();
    const oauth = dynamic.oauth("strava");
    const res = await oauth.start(principal, { state: { returnTo: "/connections" } });
    expect(res.status).toBe("redirect");
    const url = new URL((res as { authorizationUrl: string }).authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://idp.example.com/oauth/authorize");
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{32}\./);
  });

  it("oauth(name) completes the code exchange and disconnect clears the grant", async () => {
    stubFetch();
    const { dynamic, vault } = await setup();
    const oauth = dynamic.oauth("strava");
    const start = await oauth.start(principal);
    const state = new URL(
      (start as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;
    await oauth.finish(principal, { code: "auth-code", state });
    expect(await oauth.isAuthorized(principal)).toBe(true);
    expect(await vault.get(principal, "oauth2:strava:tokens")).toBeDefined();

    await oauth.provider(principal).invalidateCredentials?.("all");
    expect(await oauth.isAuthorized(principal)).toBe(false);
    expect(await vault.get(principal, "oauth2:strava:tokens")).toBeUndefined();
  });

  it("oauth(name) still routes MCP connections to the discovery flow", async () => {
    stubFetch();
    const { dynamic, store } = await setup();
    await store.add(principal, "user", {
      kind: "mcp",
      name: "some_mcp",
      mcp: { url: "https://mcp.example.com/mcp" },
      auth: { kind: "bearer", token: "t" },
    });
    // Not configured for interactive OAuth → the MCP flow's own error surfaces.
    await expect(dynamic.oauth("some_mcp").start(principal)).rejects.toThrow(
      /not configured for OAuth/,
    );
  });
});

describe("oauth2 client secrets held by reference", () => {
  it("sends the referenced secret, and the current value after a rotation", async () => {
    const calls = stubFetch();
    const { dynamic, secrets, vault } = await setup({ clientSecretRef: "strava_client_secret" });
    await vault.set(
      principal,
      "oauth2:strava:tokens",
      JSON.stringify({
        access_token: "at-live",
        refresh_token: "rt-live",
        expires_at: Date.now() - 1, // expired → forces a refresh POST we can read
        cfg: oauth2ConfigFingerprint({
          authorizeUrl: "https://idp.example.com/oauth/authorize",
          tokenUrl: "https://idp.example.com/oauth/token",
          clientId: "cid-1",
          clientSecret: "sec-1",
          scopes: ["read"],
          fingerprint: JSON.stringify([SPEC_URL, API_BASE]),
        }),
      }),
    );

    const body = () =>
      String(calls.filter((c) => c.url.endsWith("/oauth/token")).at(-1)!.init!.body);

    const opened = await dynamic.hostFor(["strava"]).open(principal);
    const tool = opened.tools.strava_getAthlete as {
      execute: (i: unknown, o: unknown) => Promise<unknown>;
    };
    await tool.execute({}, { toolCallId: "t1", messages: [], context: { principal } });
    expect(body()).toContain("client_secret=sec-1");
    await opened.close();

    // Rotate on the Secrets page. Nothing else changes — no re-save of the
    // connection, no cache to bust — and the next token POST uses the new value.
    await secrets.set(principal, "strava_client_secret", "user", "sec-2");
    await vault.set(
      principal,
      "oauth2:strava:tokens",
      JSON.stringify({
        access_token: "at-live",
        refresh_token: "rt-live",
        expires_at: Date.now() - 1,
        cfg: oauth2ConfigFingerprint({
          authorizeUrl: "https://idp.example.com/oauth/authorize",
          tokenUrl: "https://idp.example.com/oauth/token",
          clientId: "cid-1",
          clientSecret: "sec-2",
          scopes: ["read"],
          fingerprint: JSON.stringify([SPEC_URL, API_BASE]),
        }),
      }),
    );
    const again = await dynamic.hostFor(["strava"]).open(principal);
    const tool2 = again.tools.strava_getAthlete as {
      execute: (i: unknown, o: unknown) => Promise<unknown>;
    };
    await tool2.execute({}, { toolCallId: "t2", messages: [], context: { principal } });
    expect(body()).toContain("client_secret=sec-2");
    await again.close();
  });

  it("keeps the grant when a legacy inline secret migrates to this connection's own ref", async () => {
    // Decision: inline and the ref minted from it on first retype are ONE
    // credential in two places. The user retyping their client secret must not
    // sign every member of the org out of the connection.
    stubFetch();
    const inline = await setup();
    await inline.authorize();
    expect(await inline.dynamic.oauth("strava").isAuthorized(principal)).toBe(true);

    // Same seeded grant, now against a record that references its own secret.
    const migrated = await setup({ clientSecretRef: "strava_client_secret" });
    await migrated.authorize();
    expect(await migrated.dynamic.oauth("strava").isAuthorized(principal)).toBe(true);
  });

  it("drops the grant when the connection is repointed at a different secret", async () => {
    // A different named credential is a different client as far as consent goes.
    stubFetch();
    const { dynamic, store, secrets, authorize } = await setup({
      clientSecretRef: "strava_client_secret",
    });
    await authorize();
    expect(await dynamic.oauth("strava").isAuthorized(principal)).toBe(true);

    await secrets.set(principal, "someone_elses_app", "user", "sec-9");
    const conn = (await store.get(principal, "strava"))!;
    await store.add(principal, "user", {
      ...conn,
      auth: { ...conn.auth, kind: "oauth2", clientSecretRef: "someone_elses_app" } as never,
    });
    expect(await dynamic.oauth("strava").isAuthorized(principal)).toBe(false);
  });

  it("reports an oauth2 connection whose secret is gone as unauthorized, not as a page-wide failure", async () => {
    stubFetch();
    const { dynamic, secrets, authorize } = await setup({ clientSecretRef: "strava_client_secret" });
    await authorize();
    await secrets.remove(principal, "strava_client_secret", "user");
    expect(await dynamic.status(principal)).toEqual([
      { name: "strava", oauth: true, authorized: false },
    ]);
  });

  it("a broken connection exposes ONLY a gated reconnect tool carrying the reason", async () => {
    // The grant is still in the vault, but the client it was minted for can no
    // longer authenticate: no API tools may go out on a token we can't refresh.
    // But a declared connection failing must not VANISH either — silently
    // absent tools let an agent answer confidently without the plane it was
    // built around (observed live: a generic market answer instead of "your
    // client workspace is unreachable"). The failure surfaces as a GATED
    // connect_<name> whose description names the reason: the model confronts
    // the breakage (gated call → parked turn → connect card) instead of
    // degrading into a generic answer.
    stubFetch();
    const { dynamic, secrets, authorize } = await setup({ clientSecretRef: "strava_client_secret" });
    await authorize();
    expect(Object.keys((await dynamic.hostFor(["strava"]).open(principal)).tools)).toContain(
      "strava_getAthlete",
    );
    await secrets.remove(principal, "strava_client_secret", "user");
    const opened = await dynamic.hostFor(["strava"]).open(principal);
    expect(Object.keys(opened.tools)).toEqual(["connect_strava"]);
    expect(opened.toolApproval).toMatchObject({ connect_strava: "user-approval" });
    expect(opened.alwaysActive).toContain("connect_strava");
    const description = (opened.tools.connect_strava as { description: string }).description;
    expect(description).toContain("FAILED to open");
    await opened.close();
  });

  it("revokes the connection when its referenced secret is deleted", async () => {
    // Delete has to mean revoke: no tools, a reported error, and nothing sent.
    stubFetch();
    const errors: string[] = [];
    const vault = memoryVault();
    const store = createConnectionStore(vault);
    const secrets = createNamedSecrets(vault);
    await secrets.set(principal, "petstore_token", "user", "key-1");
    await store.add(principal, "user", {
      kind: "openapi",
      name: "strava",
      openapi: { spec: SPEC_URL, baseUrl: API_BASE },
      auth: { kind: "header", header: "api_key", tokenRef: "petstore_token" },
    });
    const dynamic = createDynamicConnections({
      store,
      secrets,
      vault,
      callbackBaseUrl: "http://localhost:3000/api/latch/connections",
      onConnectionError: (name, err) => errors.push(`${name}: ${String(err)}`),
    });

    const opened = await dynamic.hostFor(["strava"]).open(principal);
    expect(Object.keys(opened.tools)).toEqual(["strava_getAthlete"]);
    await opened.close();

    await secrets.remove(principal, "petstore_token", "user");
    const after = await dynamic.hostFor(["strava"]).open(principal);
    expect(Object.keys(after.tools)).toEqual([]);
    expect(errors.join()).toMatch(/petstore_token/);
    await after.close();
  });

  it("contains a revoked connection instead of taking the turn's other tools down", async () => {
    stubFetch();
    const errors: string[] = [];
    const vault = memoryVault();
    const store = createConnectionStore(vault);
    const secrets = createNamedSecrets(vault);
    await store.add(principal, "user", {
      kind: "openapi",
      name: "strava",
      openapi: { spec: SPEC_URL, baseUrl: API_BASE },
      auth: { kind: "header", header: "api_key", tokenRef: "deleted_secret" },
    });
    await store.add(principal, "user", {
      kind: "openapi",
      name: "healthy",
      openapi: { spec: SPEC_URL, baseUrl: API_BASE },
    });
    const dynamic = createDynamicConnections({
      store,
      secrets,
      vault,
      callbackBaseUrl: "http://localhost:3000/api/latch/connections",
      onConnectionError: (name, err) => errors.push(`${name}: ${String(err)}`),
    });

    const opened = await dynamic.hostFor(["strava", "healthy"]).open(principal);
    expect(Object.keys(opened.tools)).toEqual(["healthy_getAthlete"]);
    expect(errors).toHaveLength(1);
    await opened.close();
  });
});
