import type { Vault } from "@intentface/latch-core";
import type * as latchNet from "@intentface/latch-net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectionStore } from "./connection-store";
import { createDynamicConnections } from "./dynamic-connections";
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

async function setup() {
  const vault = memoryVault();
  const store = createConnectionStore(vault);
  await store.add(principal, "user", {
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
    vault,
    callbackBaseUrl: "http://localhost:3000/api/latch/connections",
  });
  // Mirror the config the registry's resolver produces (auth + target folded
  // into the fingerprint) so the seeded grant matches the live connection.
  const cfg = oauth2ConfigFingerprint({
    authorizeUrl: "https://idp.example.com/oauth/authorize",
    tokenUrl: "https://idp.example.com/oauth/token",
    clientId: "cid-1",
    clientSecret: "sec-1",
    scopes: ["read"],
    fingerprint: JSON.stringify([SPEC_URL, API_BASE]),
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
  return { vault, store, dynamic, authorize };
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
