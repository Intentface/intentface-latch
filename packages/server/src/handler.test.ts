import { describe, expect, it, vi } from "vitest";
import { createLatchHandler } from "./handler.js";

/**
 * The OAuth connection routes' identity discipline:
 *
 * - `authorize` pins the RESOLVED principal (+ iat) into the flow state, so
 * - `callback` rebuilds identity from the pin via `reconstructPrincipal` and
 *   never consults the live session — a degraded session at redirect time
 *   must not decide where credentials land.
 * - Stale pins are rejected (`flow_expired`), and so is a callback with no pin
 *   at all — the live session is never asked to stand in for a flow.
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
  resolvePrincipal?: (req: Request) => P | null;
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
  const resolvePrincipal = vi.fn(
    opts?.resolvePrincipal ?? (() => ({ orgId: "org_a", userId: "u1" })),
  );
  const handler = createLatchHandler<P>({
    runtime: {} as never,
    connections: conns as never,
    basePath: "/api/latch",
    resolvePrincipal,
    reconstructPrincipal: opts?.reconstructPrincipal,
    oauthFlowMaxAgeMs: opts?.oauthFlowMaxAgeMs,
  });
  return { handler, start, finish, resolvePrincipal };
}

const authorize = (q = "") =>
  new Request(`https://app.example/api/latch/connections/loredex/authorize${q}`);
const callback = (state: string, code = "abc") =>
  new Request(
    `https://app.example/api/latch/connections/loredex/callback?code=${code}&state=${encodeURIComponent(state)}`,
  );

describe("resolvePrincipal", () => {
  it("still accepts its old name, resolveContext", async () => {
    const resolveContext = vi.fn(() => null);
    const handler = createLatchHandler<P>({ runtime: {} as never, basePath: "/api/latch", resolveContext });
    const res = await handler(new Request("https://app.example/api/latch/chats"));
    expect(res?.status).toBe(401);
    expect(resolveContext).toHaveBeenCalled();
  });

  it("is required: without it the handler refuses to be built", () => {
    expect(() => createLatchHandler<P>({ runtime: {} as never })).toThrow(/pass resolvePrincipal/);
  });
});

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
    const { handler, finish, resolvePrincipal } = build({
      // A live session would resolve to a DIFFERENT principal (the incident
      // shape: personal tenant). It must not be asked at all.
      resolvePrincipal: () => {
        throw new Error("resolvePrincipal must not run on a pinned callback");
      },
    });
    const res = await handler(callback(pinnedState()));
    expect(res?.status).toBe(302);
    expect(res?.headers.get("location")).toContain("connected=loredex");
    expect(resolvePrincipal).not.toHaveBeenCalled();
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

describe("callback without a pin", () => {
  it.each([
    ["no state param", "https://app.example/api/latch/connections/loredex/callback?code=abc"],
    ["malformed state", "https://app.example/api/latch/connections/loredex/callback?code=abc&state=not-a-state"],
  ])("%s is rejected as expired and never reaches the session", async (_label, href) => {
    const { handler, finish, resolvePrincipal } = build({
      resolvePrincipal: () => {
        throw new Error("resolvePrincipal must not run on any callback");
      },
    });
    const res = await handler(new Request(href));
    expect(res?.status).toBe(302);
    const loc = res?.headers.get("location") ?? "";
    expect(loc.startsWith("/")).toBe(true);
    expect(loc).toContain("error=flow_expired");
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it("is rejected as expired — the session is never a stand-in for a flow", async () => {
    const { handler, finish, resolvePrincipal } = build({
      resolvePrincipal: () => {
        throw new Error("resolvePrincipal must not run on any callback");
      },
    });
    const res = await handler(callback(encodeState({ returnTo: "/x" })));
    expect(res?.status).toBe(302);
    const loc = res?.headers.get("location") ?? "";
    expect(loc.startsWith("/x")).toBe(true);
    expect(loc).toContain("error=flow_expired");
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });
});

/**
 * The schedules + runs projections. These routes are "a convenience over the
 * contract" — but a convenience that silently DROPS fields is worse than an
 * absent route: the caller gets a 200 and a schedule that ignores what they
 * asked for. Every runtime option the route accepts must arrive at
 * `runtime.schedule()`, and the run projection must not ship server-only state
 * to a browser.
 */

interface StubSchedule {
  id: string;
  agent: string;
  prompt: string;
  delivery?: unknown;
  onParked?: string;
}

function buildRoutes(opts?: { schedules?: StubSchedule[]; runNow?: boolean }) {
  const schedule = vi.fn(async (input: Record<string, unknown>) => ({
    id: "sch_1",
    ...input,
  }));
  const runScheduleNow = vi.fn(async (_i: { principal: P; id: string }) => opts?.runNow ?? true);
  const unschedule = vi.fn(async (_i: { principal: P; id: string }) => {});
  const listSchedules = vi.fn(async () => opts?.schedules ?? []);
  const listRuns = vi.fn(async () => [
    {
      id: "run_1",
      chatId: "chat_1",
      agent: "briefer",
      status: "awaiting_input",
      identity: { orgId: "org_a", userId: "u1", plan: "enterprise" },
      costTotal: 0.19,
      startedAt: 1,
    },
  ]);
  const handler = createLatchHandler<P>({
    runtime: { schedule, runScheduleNow, unschedule, listSchedules, listRuns } as never,
    connections: { oauth: () => undefined, status: async () => [], testTools: async () => [] } as never,
    basePath: "/api/latch",
    resolvePrincipal: () => ({ orgId: "org_a", userId: "u1" }),
  });
  return { handler, schedule, runScheduleNow, unschedule, listSchedules };
}

const post = (path: string, body?: unknown) =>
  new Request(`https://app.example/api/latch/${path}`, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const get = (path: string) => new Request(`https://app.example/api/latch/${path}`);

describe("POST /schedules", () => {
  it("forwards delivery and onParked to runtime.schedule", async () => {
    const { handler, schedule } = buildRoutes();
    const res = await handler(
      post("schedules", {
        agent: "briefer",
        cron: "0 8 * * *",
        timezone: "Europe/Helsinki",
        prompt: "morning brief",
        delivery: { kind: "slack", appId: "A1", channel: "C1" },
        onParked: "fire",
      }),
    );
    expect(res?.status).toBe(200);
    const passed = schedule.mock.calls[0]![0] as Record<string, unknown>;
    expect(passed.delivery).toEqual({ kind: "slack", appId: "A1", channel: "C1" });
    expect(passed.onParked).toBe("fire");
    expect(passed.timezone).toBe("Europe/Helsinki");
    // Echoed back, so a caller can see what actually stuck.
    expect((await res!.json()).schedule.delivery).toEqual({
      kind: "slack",
      appId: "A1",
      channel: "C1",
    });
  });

  it("omits both when unset — no invented defaults", async () => {
    const { handler, schedule } = buildRoutes();
    await handler(post("schedules", { agent: "briefer", cron: null, prompt: "brief" }));
    const passed = schedule.mock.calls[0]![0] as Record<string, unknown>;
    expect(passed.delivery).toBeUndefined();
    expect(passed.onParked).toBeUndefined();
  });

  it("400s an unknown onParked instead of silently defaulting it", async () => {
    const { handler, schedule } = buildRoutes();
    const res = await handler(
      post("schedules", { agent: "briefer", cron: null, prompt: "b", onParked: "skipp" }),
    );
    expect(res?.status).toBe(400);
    expect(schedule).not.toHaveBeenCalled();
  });
});

describe("GET /schedules/:id and POST /schedules/:id/run-now", () => {
  it("returns one of the caller's schedules", async () => {
    const { handler } = buildRoutes({
      schedules: [{ id: "sch_1", agent: "briefer", prompt: "a" }],
    });
    const res = await handler(get("schedules/sch_1"));
    expect(res?.status).toBe(200);
    expect((await res!.json()).schedule.id).toBe("sch_1");
  });

  it("404s an id that isn't in the caller's own list (another tenant's included)", async () => {
    const { handler } = buildRoutes({ schedules: [] });
    expect((await handler(get("schedules/sch_other")))?.status).toBe(404);
  });

  it("arms run-now through the runtime, and 404s a spent one-shot", async () => {
    const { handler, runScheduleNow } = buildRoutes();
    expect((await handler(post("schedules/sch_1/run-now")))?.status).toBe(200);
    expect(runScheduleNow.mock.calls[0]![0]).toEqual({
      principal: { orgId: "org_a", userId: "u1" },
      id: "sch_1",
    });
    const spent = buildRoutes({ runNow: false });
    expect((await spent.handler(post("schedules/sch_1/run-now")))?.status).toBe(404);
  });

  it("still deletes on DELETE /schedules/:id", async () => {
    const { handler, unschedule } = buildRoutes();
    const res = await handler(
      new Request("https://app.example/api/latch/schedules/sch_1", { method: "DELETE" }),
    );
    expect(res?.status).toBe(200);
    expect(unschedule).toHaveBeenCalled();
  });
});

describe("GET /runs", () => {
  it("strips the identity blob — the principal is server state, not a payload", async () => {
    const { handler } = buildRoutes();
    const res = await handler(get("runs"));
    const { runs } = (await res!.json()) as { runs: Record<string, unknown>[] };
    expect(runs).toHaveLength(1);
    expect("identity" in runs[0]!).toBe(false);
    // Everything a cost/usage UI actually needs still comes through.
    expect(runs[0]).toMatchObject({ id: "run_1", chatId: "chat_1", costTotal: 0.19 });
  });
});

describe("POST /agents/:agent/:id with a message the runtime refuses", () => {
  it("answers 400 invalid_message instead of a 500", async () => {
    const { InvalidMessageError } = await import("@intentface/latch-core");
    const handleChat = vi.fn(async () => {
      throw new InvalidMessageError('a chat message must be a user message, not "assistant"');
    });
    const handler = createLatchHandler<P>({
      runtime: { handleChat } as never,
      connections: { oauth: () => undefined, status: async () => [], testTools: async () => [] } as never,
      basePath: "/api/latch",
      resolvePrincipal: () => ({ orgId: "org_a", userId: "u1" }),
    });
    const res = (await handler(
      post("agents/assistant/chat_1", { message: { id: "m1", role: "assistant", parts: [{ type: "text", text: "x" }] } }),
    ))!;
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_message" });
  });
});

describe("POST /agents/:agent/:id with useChat's default body ({ messages })", () => {
  function route() {
    const handleChat = vi.fn(async (_input: { message: unknown }) => new Response("ok"));
    const handler = createLatchHandler<P>({
      runtime: { handleChat } as never,
      connections: { oauth: () => undefined, status: async () => [], testTools: async () => [] } as never,
      basePath: "/api/latch",
      resolvePrincipal: () => ({ orgId: "org_a", userId: "u1" }),
    });
    return { handler, handleChat };
  }

  it("passes the newest message on with its id and attachments", async () => {
    const { handler, handleChat } = route();
    const newest = {
      id: "m2",
      role: "user",
      parts: [
        { type: "file", mediaType: "image/png", url: "data:image/png;base64,AAAA" },
        { type: "text", text: "what is this?" },
      ],
    };
    await handler(post("agents/assistant/chat_1", { id: "chat_1", trigger: "submit-message", messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "earlier" }] }, newest] }));
    expect(handleChat.mock.calls[0]![0].message).toEqual(newest);
  });

  it("passes useChat's approval answers on unchanged, for the runtime to read", async () => {
    const { handler, handleChat } = route();
    const answers = { id: "a1", role: "assistant", parts: [{ type: "tool-refund", toolCallId: "t1", state: "approval-responded", input: {}, approval: { id: "ap1", approved: true } }] };
    await handler(post("agents/assistant/chat_1", { messages: [answers] }));
    expect(handleChat.mock.calls[0]![0].message).toEqual(answers);
  });

  it("still builds a message from { text }", async () => {
    const { handler, handleChat } = route();
    await handler(post("agents/assistant/chat_1", { text: "hello" }));
    expect(handleChat.mock.calls[0]![0].message).toMatchObject({ role: "user", parts: [{ type: "text", text: "hello" }] });
  });
});

describe("POST /agents/:agent/:id regenerating or editing an earlier question", () => {
  it("answers 409 rewind_not_supported", async () => {
    const { RewindNotSupportedError } = await import("@intentface/latch-core");
    const handleChat = vi.fn(async () => {
      throw new RewindNotSupportedError("m1");
    });
    const handler = createLatchHandler<P>({
      runtime: { handleChat } as never,
      connections: { oauth: () => undefined, status: async () => [], testTools: async () => [] } as never,
      basePath: "/api/latch",
      resolvePrincipal: () => ({ orgId: "org_a", userId: "u1" }),
    });
    const res = (await handler(post("agents/assistant/chat_1", { message: { id: "m1", role: "user", parts: [{ type: "text", text: "x" }] } })))!;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "rewind_not_supported" });
  });
});

describe("POST /agents/:agent/:id with params", () => {
  function route(impl: (input: { params?: unknown }) => Promise<Response>) {
    const handleChat = vi.fn(impl);
    const handler = createLatchHandler<P>({
      runtime: { handleChat } as never,
      connections: { oauth: () => undefined, status: async () => [], testTools: async () => [] } as never,
      basePath: "/api/latch",
      resolvePrincipal: () => ({ orgId: "org_a", userId: "u1" }),
    });
    return { handler, handleChat };
  }
  const message = { id: "m1", role: "user", parts: [{ type: "text", text: "x" }] };

  it("passes body.params to the runtime, and nothing when absent", async () => {
    const { handler, handleChat } = route(async () => new Response("ok"));
    await handler(post("agents/support/chat_1", { message, params: { ticketId: "T-9" } }));
    await handler(post("agents/support/chat_1", { message }));
    expect(handleChat.mock.calls[0]![0].params).toEqual({ ticketId: "T-9" });
    expect("params" in handleChat.mock.calls[1]![0]).toBe(false);
  });

  it("answers 400 invalid_params and 409 params_fixed", async () => {
    const { InvalidParamsError, ParamsFixedError } = await import("@intentface/latch-core");
    const invalid = route(async () => {
      throw new InvalidParamsError('params for "support" don\'t match its schema');
    });
    const bad = (await invalid.handler(post("agents/support/chat_1", { message, params: {} })))!;
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "invalid_params" });

    const fixed = route(async () => {
      throw new ParamsFixedError("chat_1");
    });
    const changed = (await fixed.handler(post("agents/support/chat_1", { message, params: { ticketId: "T-10" } })))!;
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ code: "params_fixed" });
  });
});

describe("DELETE chats/:id", () => {
  const del = (id: string) => new Request(`https://app.example/api/latch/chats/${id}`, { method: "DELETE" });
  const handlerWith = (deleteChat: (input: { principal: P; chatId: string }) => Promise<{ deleted: string[] }>) =>
    createLatchHandler<P>({
      runtime: { deleteChat } as never,
      basePath: "/api/latch",
      resolvePrincipal: () => ({ orgId: "org_a", userId: "u1" }),
    });

  it("deletes the caller's chat and lists what went", async () => {
    const res = await handlerWith(async ({ chatId }) => ({ deleted: [chatId, "sub_1"] }))(del("c1"));
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ deleted: ["c1", "sub_1"] });
  });

  it("is 404 for a chat that isn't the caller's", async () => {
    expect((await handlerWith(async () => ({ deleted: [] }))(del("c1")))?.status).toBe(404);
  });

  it("is 409 while an answer runs, and 501 when storage can't delete", async () => {
    const busy = Object.assign(new Error("busy"), { code: "chat_busy", retryAfterMs: 2_000 });
    expect((await handlerWith(async () => Promise.reject(busy))(del("c1")))?.status).toBe(409);
    const unsupported = Object.assign(new Error("no"), { code: "unsupported" });
    expect((await handlerWith(async () => Promise.reject(unsupported))(del("c1")))?.status).toBe(501);
  });
});
