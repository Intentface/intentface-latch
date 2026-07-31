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

const { createMcpOAuth } = await import("./oauth.js");

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
