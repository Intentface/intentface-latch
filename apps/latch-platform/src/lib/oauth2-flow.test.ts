import { createHash } from "node:crypto";
import type { Vault } from "@intentface/latch-core";
import type * as latchNet from "@intentface/latch-net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuth2Endpoints } from "./oauth2-flow";
import { assertPublicHttpsUrl, createOAuth2Flow, oauth2ConfigFingerprint } from "./oauth2-flow";

// The DNS-rebinding backstop fails closed on lookup errors, which would block
// the fake IdP hostnames used here. Literal-IP/localhost cases still exercise
// the real string-level `isBlockedHost`.
vi.mock("@intentface/latch-net", async (importOriginal) => {
  const actual = await importOriginal<typeof latchNet>();
  return { ...actual, isBlockedResolved: async () => false };
});

type P = { orgId: string; userId?: string };

/** In-memory Vault stub — enough surface for the OAuth flow. */
function memoryVault(): Vault<P> {
  const data = new Map<string, string>();
  const k = (p: P, key: string) => `${p.orgId}/${p.userId ?? ""}:${key}`;
  return {
    set: async (p: P, key: string, value: string) => void data.set(k(p, key), value),
    get: async (p: P, key: string) => data.get(k(p, key)),
    has: async (p: P, key: string) => data.has(k(p, key)),
    delete: async (p: P, key: string) => void data.delete(k(p, key)),
    list: async () => [...data.keys()],
    resolver: { get: async () => undefined },
  } as unknown as Vault<P>;
}

const principal: P = { orgId: "org1", userId: "user1" };
const TOKENS_KEY = "oauth2:strava:tokens";

const BASE_CFG: OAuth2Endpoints = {
  authorizeUrl: "https://idp.example.com/oauth/authorize",
  tokenUrl: "https://idp.example.com/oauth/token",
  clientId: "cid-1",
  clientSecret: "sec-1",
  scopes: ["read,activity:read_all"],
};

function flow(vault = memoryVault(), cfg: OAuth2Endpoints = BASE_CFG) {
  // `box.cfg` is mutable so tests can reconfigure the connection mid-flight,
  // like an edit through the UI would.
  const box = { cfg };
  const f = createOAuth2Flow<P>({
    vault,
    name: "strava",
    callbackBaseUrl: "http://localhost:3000/api/latch/connections",
    config: async () => box.cfg,
    ownerKey: (p) => `${p.orgId}/${p.userId ?? ""}`,
    // Late-bound delegate so `vi.stubGlobal("fetch", ...)` in each test still
    // intercepts (the default would be the DNS-pinned fetch → real network).
    fetch: (input, init) => globalThis.fetch(input, init),
  });
  return { flow: f, vault, box };
}

const tokenResponse = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const seedTokens = (
  vault: Vault<P>,
  tokens: { access_token: string; refresh_token?: string; expires_at?: number },
  cfg: OAuth2Endpoints = BASE_CFG,
) =>
  vault.set(
    principal,
    TOKENS_KEY,
    JSON.stringify({ ...tokens, cfg: oauth2ConfigFingerprint(cfg) }),
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOAuth2Flow start/finish", () => {
  it("start() builds the authorize URL with PKCE and the handler's state format", async () => {
    const { flow: f, vault } = flow();
    const res = await f.start(principal, { state: { returnTo: "/connections" } });
    expect(res.status).toBe("redirect");
    const url = new URL((res as { authorizationUrl: string }).authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://idp.example.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid-1");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/latch/connections/strava/callback",
    );
    // Comma-delimited provider scopes survive as one item.
    expect(url.searchParams.get("scope")).toBe("read,activity:read_all");
    // state = <csrf>.<b64url payload> — handler's decodeOAuthState needs the dot
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{32}\./);
    // PKCE: challenge = S256(stored verifier)
    const verifier = await vault.get(principal, "oauth2:strava:verifier");
    expect(verifier).toBeTruthy();
    const expected = createHash("sha256").update(verifier!).digest("base64url");
    expect(url.searchParams.get("code_challenge")).toBe(expected);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("start() merges standard params into a pre-configured query", async () => {
    const { flow: f } = flow(memoryVault(), {
      ...BASE_CFG,
      authorizeUrl:
        "https://idp.example.com/oauth/authorize?audience=https%3A%2F%2Fapi.example.com&prompt=consent",
    });
    const res = await f.start(principal);
    const url = new URL((res as { authorizationUrl: string }).authorizationUrl);
    // provider-specific params survive…
    expect(url.searchParams.get("audience")).toBe("https://api.example.com");
    expect(url.searchParams.get("prompt")).toBe("consent");
    // …alongside the standard ones
    expect(url.searchParams.get("client_id")).toBe("cid-1");
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{32}\./);
  });

  it("start() short-circuits to authorized when tokens exist", async () => {
    const { flow: f, vault } = flow();
    await seedTokens(vault, { access_token: "at", refresh_token: "rt" });
    expect(await f.start(principal)).toEqual({ status: "authorized" });
  });

  it("finish() rejects a state mismatch (CSRF)", async () => {
    const { flow: f } = flow();
    await f.start(principal);
    await expect(f.finish(principal, { code: "c", state: "deadbeef.e30" })).rejects.toThrow(
      /state mismatch/,
    );
  });

  it("finish() exchanges the code with the verifier and stores tokens", async () => {
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async () => tokenResponse({ access_token: "at-1", expires_in: 3600, refresh_token: "rt-1" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { flow: f, vault } = flow();
    const start = await f.start(principal);
    const state = new URL(
      (start as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;
    const verifier = await vault.get(principal, "oauth2:strava:verifier");

    expect(await f.isAuthorized(principal)).toBe(false);
    await f.finish(principal, { code: "auth-code", state });
    expect(await f.isAuthorized(principal)).toBe(true);

    const init = fetchMock.mock.calls[0][1]!;
    const body = String(init.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=auth-code");
    expect(body).toContain(`code_verifier=${verifier}`);
    expect(body).toContain("client_id=cid-1");
    expect(body).toContain("client_secret=sec-1");
    // Redirects would replay the secret to an unvetted host; a hung IdP must time out.
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const stored = JSON.parse((await vault.get(principal, TOKENS_KEY))!);
    expect(stored).toMatchObject({ access_token: "at-1", refresh_token: "rt-1" });
    expect(stored.expires_at).toBeGreaterThan(Date.now());
    // one-time secrets are consumed
    expect(await vault.get(principal, "oauth2:strava:verifier")).toBeUndefined();
    expect(await vault.get(principal, "oauth2:strava:csrf")).toBeUndefined();
  });

  it("finish() accepts a response without a refresh token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenResponse({ access_token: "at-only", expires_in: 3600 })),
    );
    const { flow: f } = flow();
    const start = await f.start(principal);
    const state = new URL(
      (start as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;
    await f.finish(principal, { code: "c", state });
    expect(await f.isAuthorized(principal)).toBe(true);
  });
});

describe("accessTokenFor", () => {
  it("returns a fresh cached token without a network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { flow: f, vault } = flow();
    await seedTokens(vault, {
      access_token: "at-fresh",
      refresh_token: "rt",
      expires_at: Date.now() + 3_600_000,
    });
    expect(await f.accessTokenFor(principal)).toBe("at-fresh");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and persists the ROTATED refresh token", async () => {
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async () => tokenResponse({ access_token: "at-2", expires_in: 3600, refresh_token: "rt-2" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { flow: f, vault } = flow();
    await seedTokens(vault, {
      access_token: "at-1",
      refresh_token: "rt-1",
      expires_at: Date.now() - 1000,
    });
    expect(await f.accessTokenFor(principal)).toBe("at-2");
    const body = String(fetchMock.mock.calls[0][1]!.body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=rt-1");
    const stored = JSON.parse((await vault.get(principal, TOKENS_KEY))!);
    expect(stored.refresh_token).toBe("rt-2"); // rotation persisted
    expect(stored.access_token).toBe("at-2");
  });

  it("keeps the previous refresh token when the response omits one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenResponse({ access_token: "at-2", expires_in: 3600 })),
    );
    const { flow: f, vault } = flow();
    await seedTokens(vault, {
      access_token: "at-1",
      refresh_token: "rt-1",
      expires_at: Date.now() - 1000,
    });
    await f.accessTokenFor(principal);
    const stored = JSON.parse((await vault.get(principal, TOKENS_KEY))!);
    expect(stored.refresh_token).toBe("rt-1");
  });

  it("refreshes a token inside the expiry skew window", async () => {
    const fetchMock = vi.fn(async () =>
      tokenResponse({ access_token: "at-2", expires_in: 3600, refresh_token: "rt-2" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { flow: f, vault } = flow();
    await seedTokens(vault, {
      access_token: "at-1",
      refresh_token: "rt-1",
      expires_at: Date.now() + 30_000, // < 60s skew
    });
    expect(await f.accessTokenFor(principal)).toBe("at-2");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("single-flights concurrent refreshes (one token POST for two callers)", async () => {
    const fetchMock = vi.fn(async () =>
      tokenResponse({ access_token: "at-2", expires_in: 3600, refresh_token: "rt-2" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { flow: f, vault } = flow();
    await seedTokens(vault, {
      access_token: "at-1",
      refresh_token: "rt-1",
      expires_at: Date.now() - 1000,
    });
    const [a, b] = await Promise.all([f.accessTokenFor(principal), f.accessTokenFor(principal)]);
    expect(a).toBe("at-2");
    expect(b).toBe("at-2");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = JSON.parse((await vault.get(principal, TOKENS_KEY))!);
    expect(stored.refresh_token).toBe("rt-2");
  });

  it("invalid_grant kills the stored grant (clean reconnect path)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenResponse({ error: "invalid_grant" }, 400)),
    );
    const { flow: f, vault } = flow();
    await seedTokens(vault, {
      access_token: "at-1",
      refresh_token: "rt-dead",
      expires_at: Date.now() - 1000,
    });
    await expect(f.accessTokenFor(principal)).rejects.toThrow(/not connected/);
    expect(await vault.get(principal, TOKENS_KEY)).toBeUndefined();
    expect(await f.isAuthorized(principal)).toBe(false);
  });

  it("transient failures (5xx) keep the stored tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tokenResponse({ error: "server_error" }, 500)),
    );
    const { flow: f, vault } = flow();
    await seedTokens(vault, {
      access_token: "at-1",
      refresh_token: "rt-1",
      expires_at: Date.now() - 1000,
    });
    await expect(f.accessTokenFor(principal)).rejects.toThrow(/token endpoint 500/);
    expect(await vault.get(principal, TOKENS_KEY)).toBeDefined();
  });

  it("expired token without a refresh token degrades to not-connected", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { flow: f, vault } = flow();
    await seedTokens(vault, { access_token: "at-1", expires_at: Date.now() - 1000 });
    await expect(f.accessTokenFor(principal)).rejects.toThrow(/not connected/);
    expect(await vault.get(principal, TOKENS_KEY)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws not-connected when no tokens exist", async () => {
    const { flow: f } = flow();
    await expect(f.accessTokenFor(principal)).rejects.toThrow(/not connected/);
  });

  it("survives losing the refresh race to another instance (compare-and-delete)", async () => {
    const vault = memoryVault();
    const { flow: f } = flow(vault);
    await seedTokens(vault, {
      access_token: "at-1",
      refresh_token: "rt-stale",
      expires_at: Date.now() - 1000,
    });
    // The IdP answers invalid_grant because ANOTHER INSTANCE already rotated
    // this grant — simulate its write landing before our response is handled.
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async () => {
        await seedTokens(vault, {
          access_token: "at-rotated",
          refresh_token: "rt-rotated",
          expires_at: Date.now() + 3_600_000,
        });
        return tokenResponse({ error: "invalid_grant" }, 400);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    // The rotated grant must win — not get deleted by our stale failure.
    expect(await f.accessTokenFor(principal)).toBe("at-rotated");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = JSON.parse((await vault.get(principal, TOKENS_KEY))!);
    expect(stored.refresh_token).toBe("rt-rotated");
  });
});

describe("config fingerprint", () => {
  it("a reconfigured connection invalidates grants minted for the old config", async () => {
    const { flow: f, vault, box } = flow();
    await seedTokens(vault, {
      access_token: "at-old",
      refresh_token: "rt-old",
      expires_at: Date.now() + 3_600_000,
    });
    expect(await f.isAuthorized(principal)).toBe(true);
    // Edit the connection: same name, different client (or endpoints/target).
    box.cfg = { ...BASE_CFG, clientId: "cid-2" };
    expect(await f.isAuthorized(principal)).toBe(false);
    expect(await vault.get(principal, TOKENS_KEY)).toBeUndefined();
    await expect(f.accessTokenFor(principal)).rejects.toThrow(/not connected/);
  });

  it("rotating only the client secret keeps existing grants", async () => {
    const { flow: f, vault, box } = flow();
    await seedTokens(vault, {
      access_token: "at",
      refresh_token: "rt",
      expires_at: Date.now() + 3_600_000,
    });
    box.cfg = { ...BASE_CFG, clientSecret: "sec-2" };
    expect(await f.isAuthorized(principal)).toBe(true);
    expect(await f.accessTokenFor(principal)).toBe("at");
  });
});

describe("tenancy and disconnect", () => {
  it("grants are isolated per principal", async () => {
    const { flow: f, vault } = flow();
    await seedTokens(vault, { access_token: "at", refresh_token: "rt" });
    expect(await f.isAuthorized(principal)).toBe(true);
    expect(await f.isAuthorized({ orgId: "org1", userId: "user2" })).toBe(false);
  });

  it("provider().invalidateCredentials drops every vault entry", async () => {
    const { flow: f, vault } = flow();
    await f.start(principal); // writes csrf + verifier
    await seedTokens(vault, { access_token: "at", refresh_token: "rt" });
    await f.provider(principal).invalidateCredentials?.("all");
    expect(await vault.get(principal, TOKENS_KEY)).toBeUndefined();
    expect(await vault.get(principal, "oauth2:strava:csrf")).toBeUndefined();
    expect(await vault.get(principal, "oauth2:strava:verifier")).toBeUndefined();
    expect(await f.isAuthorized(principal)).toBe(false);
  });
});

describe("assertPublicHttpsUrl", () => {
  it("accepts a public https URL", async () => {
    const url = await assertPublicHttpsUrl("https://idp.example.com/oauth/token");
    expect(url.hostname).toBe("idp.example.com");
  });

  it("rejects non-https, localhost and private/link-local literals", async () => {
    await expect(assertPublicHttpsUrl("not a url")).rejects.toThrow(/valid URL/);
    await expect(assertPublicHttpsUrl("http://idp.example.com/token")).rejects.toThrow(/https/);
    await expect(assertPublicHttpsUrl("https://localhost/token")).rejects.toThrow(/private/);
    await expect(assertPublicHttpsUrl("https://169.254.169.254/token")).rejects.toThrow(/private/);
    await expect(assertPublicHttpsUrl("https://10.0.0.1/token")).rejects.toThrow(/private/);
  });
});
