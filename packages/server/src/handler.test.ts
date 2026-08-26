import { describe, expect, it, vi } from "vitest";
import { createLatchHandler } from "./handler.js";

/**
 * The OAuth connection routes' identity discipline:
 *
 * - `authorize` pins the RESOLVED principal (+ iat) into the flow state, so
 * - `callback` rebuilds identity from the pin via `reconstructPrincipal` and
 *   never consults the live session — a degraded session at redirect time
 *   must not decide where credentials land.
 * - Stale pins are rejected (`flow_expired`); pre-pin legacy states fall back
 *   to `resolveContext(request, { oauthState })`.
 */

interface P {
  orgId: string;
  userId: string;
}

/** Mirror of oauth.ts's payload half: `<csrf>.<b64url(JSON)>`. */
function encodeState(payload: unknown): string {
  const s = JSON.stringify(payload);
  let bin = "";
  for (const ch of new TextEncoder().encode(s)) bin += String.fromCharCode(ch);
  const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `deadbeef.${b64}`;
}

function build(opts?: {
  resolveContext?: (req: Request, extra?: { oauthState?: Record<string, unknown> }) => P | null;
  reconstructPrincipal?: (identity: unknown, req: Request) => P | null | Promise<P | null>;
  oauthFlowMaxAgeMs?: number;
}) {
  const start = vi.fn(async (_p: P, _o?: { state?: Record<string, unknown> }) => ({
    status: "redirect" as const,
    authorizationUrl: "https://idp.example/authorize",
  }));
  const finish = vi.fn(async (_p: P, _params: { code: string; state?: string }) => ({
    status: "authorized" as const,
  }));
  const oauth = { isAuthorized: async () => false, start, finish, provider: () => ({}) };
  const conns = {
    oauth: (name: string) => (name === "loredex" ? oauth : undefined),
    status: async () => [],
    testTools: async () => [],
  };
  const resolveContext = vi.fn(
    opts?.resolveContext ?? (() => ({ orgId: "org_a", userId: "u1" })),
  );
  const handler = createLatchHandler<P>({
    runtime: {} as never,
    connections: conns as never,
    basePath: "/api/latch",
    resolveContext,
    reconstructPrincipal: opts?.reconstructPrincipal,
    oauthFlowMaxAgeMs: opts?.oauthFlowMaxAgeMs,
  });
  return { handler, start, finish, resolveContext };
}

const authorize = (q = "") =>
  new Request(`https://app.example/api/latch/connections/loredex/authorize${q}`);
const callback = (state: string, code = "abc") =>
  new Request(
    `https://app.example/api/latch/connections/loredex/callback?code=${code}&state=${encodeURIComponent(state)}`,
  );

describe("authorize", () => {
  it("pins the resolved principal (+ iat) into the flow state", async () => {
    const { handler, start } = build();
    const res = await handler(authorize("?returnTo=/chat/c1"));
    expect(res?.status).toBe(302);
    const state = start.mock.calls[0]![1]?.state as Record<string, unknown>;
    expect(state.returnTo).toBe("/chat/c1");
    const pin = state.__latch as { p: P; iat: number };
    expect(pin.p).toEqual({ orgId: "org_a", userId: "u1" });
    expect(typeof pin.iat).toBe("number");
    expect(Math.abs(Date.now() - pin.iat)).toBeLessThan(5_000);
  });
});

describe("callback with a pinned principal", () => {
  const pinnedState = (iat = Date.now()) =>
    encodeState({
      returnTo: "/chat/c1",
      __latch: { p: { orgId: "org_pinned", userId: "u_pinned" }, iat },
    });

  it("rebuilds identity from the pin — the session is never consulted", async () => {
    const { handler, finish, resolveContext } = build({
      // A live session would resolve to a DIFFERENT principal (the incident
      // shape: personal tenant). It must not be asked at all.
      resolveContext: () => {
        throw new Error("resolveContext must not run on a pinned callback");
      },
    });
    const res = await handler(callback(pinnedState()));
    expect(res?.status).toBe(302);
    expect(res?.headers.get("location")).toContain("connected=loredex");
    expect(resolveContext).not.toHaveBeenCalled();
    // finish — and therefore the token write — ran under the PINNED principal.
    expect(finish.mock.calls[0]![0]).toEqual({ orgId: "org_pinned", userId: "u_pinned" });
  });

  it("routes the pin through reconstructPrincipal and 401s on null", async () => {
    const seen: unknown[] = [];
    const { handler, finish } = build({
      reconstructPrincipal: (identity) => {
        seen.push(identity);
        return null; // e.g. the user is no longer an org member
      },
    });
    const res = await handler(callback(pinnedState()));
    expect(res?.status).toBe(401);
    expect(seen).toEqual([{ orgId: "org_pinned", userId: "u_pinned" }]);
    expect(finish).not.toHaveBeenCalled();
  });

  it("rejects a stale pin with ?error=flow_expired", async () => {
    const { handler, finish } = build({ oauthFlowMaxAgeMs: 60_000 });
    const res = await handler(callback(pinnedState(Date.now() - 120_000)));
    expect(res?.status).toBe(302);
    const loc = res?.headers.get("location") ?? "";
    expect(loc).toContain("error=flow_expired");
    expect(loc.startsWith("/chat/c1")).toBe(true);
    expect(finish).not.toHaveBeenCalled();
  });
});

describe("callback without a pin (legacy)", () => {
  it("falls back to resolveContext with the decoded state", async () => {
    const extras: unknown[] = [];
    const { handler, finish } = build({
      resolveContext: (_req, extra) => {
        extras.push(extra);
        return { orgId: "org_session", userId: "u1" };
      },
    });
    const res = await handler(callback(encodeState({ returnTo: "/x" })));
    expect(res?.status).toBe(302);
    expect(extras).toEqual([{ oauthState: { returnTo: "/x" } }]);
    expect(finish.mock.calls[0]![0]).toEqual({ orgId: "org_session", userId: "u1" });
  });
});
