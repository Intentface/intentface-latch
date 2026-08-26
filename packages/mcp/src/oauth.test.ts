import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `scope` may be a function, resolved per caller at flow time.
 *
 * This is a correctness requirement rather than API sugar: a single `McpOAuth`
 * is shared across callers (UI-added connections are cached by connection
 * NAME, while the connection record — and therefore its requested scopes —
 * lives in each caller's own Vault). A static scope string would send one
 * caller's scopes on another caller's authorize request, which for a
 * *restriction* scope like Loredex's `private_only` means silently handing
 * someone a broader grant than their connection asked for.
 */

const authMock = vi.hoisted(() => vi.fn());

vi.mock("@ai-sdk/mcp", () => ({
  auth: authMock,
}));

const { createMcpOAuth, decodeOAuthState } = await import("./oauth.js");

interface P {
  userId: string;
}

/** Minimal in-memory Vault, keyed by principal so callers stay separate. */
function fakeVault() {
  const store = new Map<string, string>();
  const k = (p: P, key: string) => `${p.userId}::${key}`;
  return {
    async set(p: P, key: string, value: string) {
      store.set(k(p, key), value);
    },
    async get(p: P, key: string) {
      return store.get(k(p, key));
    },
    async has(p: P, key: string) {
      return store.has(k(p, key));
    },
    async delete(p: P, key: string) {
      store.delete(k(p, key));
    },
    async list(p: P) {
      return [...store.keys()].filter((x) => x.startsWith(`${p.userId}::`));
    },
    resolver: {} as never,
    _store: store,
  };
}

function build(scope: unknown, vault = fakeVault()) {
  return {
    vault,
    oauth: createMcpOAuth<P>({
      vault: vault as never,
      config: {
        name: "loredex",
        serverUrl: "https://loredex.example/ws/mcp",
        redirectUrl: "https://latch.example/cb",
        clientMetadata: {
          client_name: "Latch (loredex)",
          redirect_uris: ["https://latch.example/cb"],
        } as never,
        scope: scope as never,
      },
    }),
  };
}

/** The `scope` value handed to the SDK on the most recent `start()`. */
const lastScope = () => authMock.mock.calls.at(-1)?.[1]?.scope;

beforeEach(() => {
  authMock.mockReset();
  authMock.mockResolvedValue("AUTHORIZED");
});

describe("createMcpOAuth scope resolution", () => {
  it("passes a static scope through unchanged", async () => {
    const { oauth } = build("private_only");
    await oauth.start({ userId: "u1" });
    expect(lastScope()).toBe("private_only");
  });

  it("omits the scope entirely when unset", async () => {
    // Connections that request nothing must keep their previous, scope-less
    // authorize request — adding an empty `scope=` would change the ask.
    const { oauth } = build(undefined);
    await oauth.start({ userId: "u1" });
    expect(lastScope()).toBeUndefined();
  });

  it("resolves a function scope per caller", async () => {
    // The core requirement: two callers of the SAME connection get their own
    // scopes, because the record is per-caller while the client is shared.
    const scopes: Record<string, string | undefined> = {
      u1: "private_only",
      u2: undefined,
    };
    const { oauth } = build((p: P) => scopes[p.userId]);

    await oauth.start({ userId: "u1" });
    expect(lastScope()).toBe("private_only");

    await oauth.start({ userId: "u2" });
    expect(lastScope()).toBeUndefined();

    // ...and back again, so nothing was cached from the first resolution.
    await oauth.start({ userId: "u1" });
    expect(lastScope()).toBe("private_only");
  });

  it("awaits an async scope resolver", async () => {
    // The real resolver reads the connection out of the Vault, so it is async.
    const { oauth } = build(async (p: P) =>
      p.userId === "u1" ? "mcp:read private_only" : undefined,
    );
    await oauth.start({ userId: "u1" });
    expect(lastScope()).toBe("mcp:read private_only");
  });
});

describe("authorizationParams", () => {
  // Providers like Google need extra authorize params the SDK doesn't model
  // (`access_type=offline&prompt=consent` for a refresh token). They are
  // appended to the SDK-built redirect URL in start().
  it("appends the configured params to the authorization URL", async () => {
    const vault = fakeVault();
    const oauth = createMcpOAuth<P>({
      vault: vault as never,
      config: {
        name: "gcal",
        serverUrl: "https://calendarmcp.example/mcp/v1",
        redirectUrl: "https://latch.example/cb",
        clientMetadata: {
          client_name: "Latch (gcal)",
          redirect_uris: ["https://latch.example/cb"],
        } as never,
        authorizationParams: { access_type: "offline", prompt: "consent" },
      },
    });
    // Simulate the SDK asking for a browser redirect.
    authMock.mockImplementationOnce(async (provider: {
      redirectToAuthorization: (url: URL) => void;
    }) => {
      provider.redirectToAuthorization(
        new URL("https://idp.example/authorize?client_id=abc"),
      );
      return "REDIRECT";
    });
    const res = await oauth.start({ userId: "u1" });
    if (res.status !== "redirect") throw new Error("expected redirect");
    const url = new URL(res.authorizationUrl);
    expect(url.searchParams.get("client_id")).toBe("abc"); // SDK params kept
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });
});

describe("state encoding", () => {
  it("round-trips app context (incl. a pinned principal) through decodeOAuthState", async () => {
    // The handler pins the resolved principal into the flow state at
    // authorize time; the callback must recover it byte-for-byte.
    const { oauth } = build(undefined);
    const stateData = {
      returnTo: "/chat/c1",
      __latch: { p: { orgId: "org_a", userId: "u1" }, iat: 1_700_000_000_000 },
    };
    let sent: string | undefined;
    authMock.mockImplementationOnce(async (provider: {
      state: () => string;
      saveState: (s: string) => Promise<void>;
      redirectToAuthorization: (url: URL) => void;
    }) => {
      sent = provider.state();
      await provider.saveState(sent);
      provider.redirectToAuthorization(new URL("https://idp.example/authorize"));
      return "REDIRECT";
    });
    await oauth.start({ userId: "u1" }, { state: stateData });
    expect(decodeOAuthState(sent)).toEqual(stateData);
  });

  it("returns undefined for a bare csrf or garbage", () => {
    expect(decodeOAuthState("deadbeef")).toBeUndefined();
    expect(decodeOAuthState("deadbeef.%%%not-b64%%%")).toBeUndefined();
    expect(decodeOAuthState(null)).toBeUndefined();
  });
});

describe("finish", () => {
  it("deletes the spent state + verifier but keeps tokens/client/as_info", async () => {
    // Single-use flow state: a replayed callback URL must find no stored flow
    // material — while the durable credential parts survive.
    const { vault, oauth } = build(undefined);
    const p: P = { userId: "u1" };
    for (const part of ["tokens", "verifier", "state", "client", "as_info"]) {
      await vault.set(p, `mcp_oauth:loredex:${part}`, "x");
    }
    authMock.mockResolvedValueOnce("AUTHORIZED");
    await oauth.finish(p, { code: "abc", state: "deadbeef" });
    expect(await vault.has(p, "mcp_oauth:loredex:state")).toBe(false);
    expect(await vault.has(p, "mcp_oauth:loredex:verifier")).toBe(false);
    expect(await vault.has(p, "mcp_oauth:loredex:tokens")).toBe(true);
    expect(await vault.has(p, "mcp_oauth:loredex:client")).toBe(true);
    expect(await vault.has(p, "mcp_oauth:loredex:as_info")).toBe(true);
  });

  it("does not delete flow state when the exchange throws", async () => {
    // A transient exchange failure must leave the flow re-tryable.
    const { vault, oauth } = build(undefined);
    const p: P = { userId: "u1" };
    await vault.set(p, "mcp_oauth:loredex:state", "s");
    await vault.set(p, "mcp_oauth:loredex:verifier", "v");
    authMock.mockRejectedValueOnce(new Error("exchange failed"));
    await expect(oauth.finish(p, { code: "abc", state: "s" })).rejects.toThrow();
    expect(await vault.has(p, "mcp_oauth:loredex:state")).toBe(true);
    expect(await vault.has(p, "mcp_oauth:loredex:verifier")).toBe(true);
  });
});

describe("invalidateCredentials", () => {
  it("clears the DCR client as well as the tokens", async () => {
    // A scope change re-runs registration: the stored client was registered
    // under the old scope, so keeping it would re-request the old grant.
    const { vault, oauth } = build("private_only");
    const p: P = { userId: "u1" };
    for (const part of ["tokens", "verifier", "state", "client", "as_info"]) {
      await vault.set(p, `mcp_oauth:loredex:${part}`, "x");
    }
    await oauth.provider(p).invalidateCredentials?.("all");
    expect(await vault.list(p)).toEqual([]);
  });

  it("leaves another caller's tokens alone", async () => {
    const { vault, oauth } = build("private_only");
    const mine: P = { userId: "u1" };
    const theirs: P = { userId: "u2" };
    await vault.set(mine, "mcp_oauth:loredex:tokens", "mine");
    await vault.set(theirs, "mcp_oauth:loredex:tokens", "theirs");
    await oauth.provider(mine).invalidateCredentials?.("all");
    expect(await vault.get(theirs, "mcp_oauth:loredex:tokens")).toBe("theirs");
  });
});
