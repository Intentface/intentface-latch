import type { ApprovalDecision, AppMessage, Runtime } from "@intentface/latch-core";
import type { McpConnections } from "@intentface/latch-mcp";
import { decodeOAuthState } from "@intentface/latch-mcp";

/**
 * The mountable Latch HTTP surface — one framework-agnostic Web handler.
 *
 * `createLatchHandler(config)` returns `(request) => Promise<Response | undefined>`
 * (`undefined` = "not one of my routes", so the host can 404). Mount it once and
 * it serves the whole runtime: chat streaming, approvals, chat/run lists,
 * history, and the *generic* connection OAuth (authorize/callback) + status/
 * test/disconnect for any MCP connection in the registry. No per-server routes.
 *
 * Auth is BYO: `resolveContext(request)` returns the `Principal` (or null →
 * 401). The core never authenticates; everything is scoped by that principal.
 *
 * Routes (relative to `basePath`):
 *   POST agents/:agent/:id              run a turn (streams a UIMessage Response)
 *   POST agents/:agent/:id/approvals    submit tool-approval decisions, continue
 *   GET  chats                          list the tenant's chats
 *   GET  chats/:id                      client-projected history for one chat
 *   GET  runs                           list the tenant's runs (usage/cost)
 *   GET  agents                         the registered agents (for a picker)
 *   GET  schedules                      list the tenant's scheduled agents
 *   GET  schedules/:id                  one schedule (404 if not the tenant's)
 *   POST schedules                      create one ({agent, cron, prompt,
 *                                       timezone?, delivery?, onParked?})
 *   POST schedules/:id/run-now          make it due on the next tick
 *   DELETE schedules/:id                delete one
 *   POST cron/run                       fire ALL due schedules (host-guarded, no user auth)
 *   GET  connections                    per-connection status for the tenant
 *   GET  connections/:name/authorize    begin OAuth → 302 to the IdP
 *   GET  connections/:name/callback     finish OAuth → 302 back (see below)
 *   POST connections/:name/disconnect   drop the tenant's stored credentials
 *   POST connections/:name/test         open the connection, list its tools
 */
/**
 * What a connection failure may tell the caller.
 *
 * A connection's URL is chosen by whoever added it, and the OAuth legs then
 * follow addresses the MCP server itself names. The SDK's errors quote the
 * remote response — `Raw body: …`, `HTTP 403 trying to load OAuth metadata
 * from …` — so returning `error.message` turns "add a custom MCP server" into
 * a read-back channel for internal HTTP responses. The full error goes to the
 * host's logger; the caller gets a stable code and, at most, a status.
 */
/**
 * Hand an error to the host's logger without letting the logger break the
 * response. A throwing hook would replace the sanitized 400/502 with a 500
 * carrying whatever it threw — the opposite of the point.
 */
function notifyError(
  hook: ((error: unknown, info: { route: string; name?: string }) => void | Promise<void>) | undefined,
  error: unknown,
  info: { route: string; name?: string },
): void {
  if (!hook) return;
  try {
    void Promise.resolve(hook(error, info)).catch(() => {});
  } catch {
    /* a logger that throws is not the caller's problem */
  }
}

function connectionFailure(
  error: unknown,
  fallback: string,
): { error: string; status?: number } {
  const message = error instanceof Error ? error.message : String(error);
  // The one detail worth returning: a status tells the user whether their
  // credentials or the server are at fault, and leaks nothing about the body.
  const status = /\b(?:HTTP|status)\s(\d{3})\b/.exec(message)?.[1];
  return { error: fallback, ...(status ? { status: Number(status) } : {}) };
}

export interface LatchHandlerConfig<P> {
  /**
   * The runtime, or a per-principal resolver. A resolver enables DB-per-tenant
   * isolation (a separate runtime/DB per tenant, e.g. one SQLite file per
   * workspace) — it's called after `resolveContext` yields the principal. A
   * single `Runtime` value fits column-scoped (`owner`) tenancy. Note: `POST
   * cron/run` (no principal) requires a static runtime OR a `cronRun` tick in
   * this config (the resolver-based setup's system-wide sweep).
   */
  runtime: Runtime<P> | ((principal: P) => Runtime<P> | Promise<Runtime<P>>);
  /**
   * Map a request to a Principal (your existing auth). Null → 401.
   *
   * NEVER consulted for identity on the OAuth callback: every flow this
   * handler starts pins the resolved principal into the flow state, and the
   * callback rebuilds identity from that pin via `reconstructPrincipal`, so a
   * degraded session at redirect time can never change where credentials land.
   * A callback whose state carries no pin is rejected as expired.
   */
  resolveContext: (request: Request) => P | null | Promise<P | null>;
  /**
   * Rebuild a Principal from the identity pinned into the OAuth flow state at
   * `authorize` time (the mirror of the runtime's `reconstructPrincipal` for
   * resume/cron). Called on the OAuth callback INSTEAD of `resolveContext` —
   * the pinned identity is the source of truth; the live session is not
   * consulted. Override to validate (e.g. re-check org membership) or
   * re-hydrate; return null to reject the callback (401). Default: cast.
   */
  reconstructPrincipal?: (
    identity: unknown,
    request: Request,
  ) => P | null | Promise<P | null>;
  /**
   * Maximum age of an OAuth flow, from `authorize` to `callback`. A callback
   * whose pinned flow state is older redirects with `?error=flow_expired`.
   * Default: 30 minutes.
   */
  oauthFlowMaxAgeMs?: number;
  /**
   * Connection registry (enables the connection routes), or a per-principal
   * resolver — the latter lets a consumer build a tenant-scoped registry (e.g.
   * a workspace's installed connectors) after the principal is known.
   */
  connections?:
    | McpConnections<P>
    | ((principal: P) => McpConnections<P> | Promise<McpConnections<P>>);
  /**
   * Called after a connection is successfully authorized (both the IdP callback
   * and the already-authorized short-circuit in `authorize`). A consumer can use
   * it to flip its own catalog/connector state to active.
   */
  onConnected?: (principal: P, connectionName: string) => void | Promise<void>;
  /**
   * Observe a failure the caller is deliberately not shown in full.
   *
   * A connection's OAuth errors quote the remote response, and the remote is an
   * address the MCP server operator chose — so the routes return a stable code
   * and at most an HTTP status, and hand the real error here. Without this the
   * detail is simply lost; wire it to your logger.
   */
  onError?: (error: unknown, info: { route: string; name?: string }) => void | Promise<void>;
  /**
   * Query param appended to the post-callback redirect signalling which
   * connection just connected (`?<connectedParam>=<name>`). Default "connected".
   */
  connectedParam?: string;
  /** Path prefix the handler is mounted under (e.g. "/api/latch"). Default "/". */
  basePath?: string;
  /**
   * Shared secret guarding `POST /cron/run` (the system-wide schedule tick).
   * When set, the request must send it as `x-latch-cron-secret`. That route is
   * NOT user-authed — it fires all tenants' due schedules — so guard it at the
   * host (cron secret / network). Omit to disable the route entirely.
   */
  cronSecret?: string;
  /**
   * The system-wide tick `POST /cron/run` fires. Required when `runtime` is a
   * resolver (DB-per-tenant): no principal exists on this route, so the host
   * must supply the tick that covers its tenants (each `runtime.cron()`). With
   * a static runtime it defaults to `runtime.cron()` — due schedules fired,
   * stalled runs reaped and resumed, in one call.
   */
  cronRun?: () => Promise<unknown>;
}

export type LatchHandler = (
  request: Request,
) => Promise<Response | undefined>;

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const redirect = (location: string): Response =>
  new Response(null, { status: 302, headers: { location } });

/**
 * A caller-supplied `returnTo` is only allowed as an app-relative path. Absolute
 * (`https://evil`) or protocol-relative (`//evil`, `/\evil`) targets are an
 * open-redirect vector — fall back to `/`.
 */
function safeReturnTo(raw: string | undefined): string {
  if (!raw || !raw.startsWith("/") || raw[1] === "/" || raw[1] === "\\") return "/";
  return raw;
}

/**
 * Redirect to a vetted relative `returnTo`, merging `params` into its query with
 * proper encoding (preserving any query the path already carries).
 */
function redirectTo(
  raw: string | undefined,
  params: Record<string, string>,
): Response {
  const [base, existing] = safeReturnTo(raw).split("?", 2);
  const qs = new URLSearchParams(existing);
  for (const [key, value] of Object.entries(params)) qs.set(key, value);
  const query = qs.toString();
  return redirect(query ? `${base}?${query}` : base);
}

/** Split a path into segments after stripping `basePath`. Null if outside it. */
function segmentsUnder(pathname: string, basePath: string): string[] | null {
  let base = basePath.replace(/\/$/, "");
  if (base === "") {
    return pathname.replace(/^\/+/, "").split("/").filter(Boolean);
  }
  if (pathname === base) return [];
  if (!pathname.startsWith(base + "/")) return null;
  return pathname.slice(base.length + 1).split("/").filter(Boolean);
}

/** Accept `{ message }`, `{ text }`, or a `useChat`-style `{ messages }` (last). */
function toUserMessage(body: Record<string, unknown>): AppMessage {
  const explicit = body.message as AppMessage | undefined;
  if (explicit?.parts) return explicit;
  let text = "";
  if (typeof body.text === "string") {
    text = body.text;
  } else if (Array.isArray(body.messages)) {
    const last = body.messages[body.messages.length - 1] as
      | AppMessage
      | undefined;
    text = (last?.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
  }
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }],
    metadata: { visibility: "user", createdAt: Date.now() },
  };
}

/**
 * The runtime's typed refusals → HTTP. Every run-producing route (a message, an
 * approval decision, a client-tool result) can meet any of these, so they all
 * map through here instead of surfacing as a host 500:
 *
 *   pending_approval  409  a decision is outstanding — resolve it first
 *   chat_busy         409  a turn is live in this chat — retry after `Retry-After`
 *   chat_conflict     409  the client-chosen chat id exists and isn't yours
 *   limit_exceeded    429  a budget is spent — retry after `Retry-After`
 */
function refusalResponse(e: unknown): Response | undefined {
  const code = e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  const message = (fallback: string) => (e instanceof Error ? e.message : fallback);
  const retryAfterMs = Number((e as { retryAfterMs?: unknown } | null)?.retryAfterMs ?? 0);
  const withRetry = (body: Record<string, unknown>, status: number) =>
    new Response(JSON.stringify({ ...body, retryAfterMs }), {
      status,
      headers: {
        "content-type": "application/json",
        "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
      },
    });
  switch (code) {
    case "pending_approval":
      return json({ error: message("awaiting approval decision"), code }, 409);
    case "chat_busy":
      return withRetry({ error: message("a turn is already running in this chat"), code }, 409);
    case "chat_conflict":
      return json({ error: message("chat id is not available"), code }, 409);
    case "limit_exceeded":
      return withRetry({ error: message("limit exceeded"), code }, 429);
    default:
      return undefined;
  }
}

export function createLatchHandler<P>(
  config: LatchHandlerConfig<P>,
): LatchHandler {
  const { runtime, resolveContext, connections } = config;
  const basePath = config.basePath ?? "/";
  /** Resolve the runtime for this request's principal (static value or per-principal resolver). */
  const resolveRuntime = (principal: P): Runtime<P> | Promise<Runtime<P>> =>
    typeof runtime === "function"
      ? (runtime as (p: P) => Runtime<P> | Promise<Runtime<P>>)(principal)
      : runtime;
  /** Resolve the connection registry for a principal (static value or per-principal resolver). */
  const resolveConnections = async (
    principal: P,
  ): Promise<McpConnections<P> | undefined> =>
    typeof connections === "function"
      ? await (
          connections as (
            p: P,
          ) => McpConnections<P> | Promise<McpConnections<P>>
        )(principal)
      : connections;

  return async (request) => {
    const url = new URL(request.url);
    const seg = segmentsUnder(url.pathname, basePath);
    if (seg === null) return undefined; // not under our mount → host handles it
    const method = request.method.toUpperCase();

    // --- connections (generic, any MCP server) ----------------------------
    // The callback may run before/without an app session, so it resolves the
    // principal itself; the other connection routes require one.
    if (seg[0] === "connections" && connections) {
      const name = seg[1];
      const action = seg[2];

      // The callback arrives at a moment we don't control (an IdP redirect),
      // so its identity must NEVER come from the live session — a degraded
      // session there is exactly how credentials end up under the wrong owner.
      // Every flow this handler starts pins the resolved principal into the
      // state (`__latch`); the callback rebuilds identity from that pin. The
      // pin is tamper-evident: the full state string is exact-matched against
      // the copy stored (owner-keyed) at authorize time, so a forged payload
      // never survives the exchange.
      const isCallback = !!name && action === "callback" && method === "GET";
      const callbackState = isCallback
        ? (decodeOAuthState(url.searchParams.get("state")) ?? undefined)
        : undefined;

      let principal: P | null;
      if (isCallback) {
        // A callback ALWAYS identifies itself by its pin. No state, an
        // undecodable state, or a state without a pin (a flow started before
        // pinning existed, or a hand-built one) is treated like a stale pin:
        // the flow can't be trusted, so it is expired — the live session is
        // never asked to stand in for it.
        const pinned = callbackState?.__latch as
          | { p?: unknown; iat?: number }
          | undefined;
        const maxAge = config.oauthFlowMaxAgeMs ?? 30 * 60_000;
        const valid =
          !!pinned && pinned.p !== undefined && typeof pinned.iat === "number";
        if (!valid || Date.now() - pinned.iat! > maxAge) {
          return redirectTo((callbackState?.returnTo as string) ?? "/", {
            error: "flow_expired",
          });
        }
        principal = await (config.reconstructPrincipal ?? ((id) => id as P))(
          pinned.p,
          request,
        );
      } else {
        principal = await resolveContext(request);
      }
      if (!principal) return json({ error: "unauthorized" }, 401);

      const conns = await resolveConnections(principal);
      if (!conns) return json({ error: "no connections configured" }, 400);

      const oauth = name ? conns.oauth(name) : undefined;

      // GET connections → status list
      if (!name && method === "GET") {
        return json({ connections: await conns.status(principal) });
      }

      // GET connections/:name/authorize → 302 to IdP
      if (name && action === "authorize" && method === "GET") {
        if (!oauth) return json({ error: `not an OAuth connection: ${name}` }, 400);
        const chatId = url.searchParams.get("chatId") ?? undefined;
        const approvalId = url.searchParams.get("approvalId") ?? undefined;
        const returnTo = url.searchParams.get("returnTo") ?? undefined;
        // Optional caller-supplied context folded into the OAuth state so the
        // callback (which may lack a session) can rebuild it — a credential-
        // scope selector.
        const scope = url.searchParams.get("scope") ?? undefined;
        // Pin the resolved principal (+ issue time) into the flow state. The
        // callback rebuilds identity from this pin via `reconstructPrincipal`
        // — the live session at redirect time never decides where credentials
        // land. Principals are IDs-only by contract, so the payload is small
        // and non-sensitive; integrity comes from the stored-state exact match.
        const state = {
          chatId,
          approvalId,
          returnTo,
          scope,
          __latch: { p: principal, iat: Date.now() },
        };
        // A connection resolved as OAuth-capable but not actually configured for
        // it (e.g. a dynamic name whose stored record isn't oauth) throws here —
        // surface it as a 400 rather than starting an orphan flow.
        let res;
        try {
          res = await oauth.start(principal, { state });
        } catch (e) {
          notifyError(config.onError, e, { route: "connections.authorize", name });
          return json(connectionFailure(e, "authorize failed"), 400);
        }
        if (res.status !== "redirect") {
          // Already authorized (tokens live in the Vault) — start()
          // short-circuits without an IdP round-trip, so the callback (which
          // signals `onConnected` and appends `connectedParam`) never runs.
          // Signal both here too, so a pending `connect_<name>` still resumes.
          await config.onConnected?.(principal, name);
          return redirectTo(returnTo, {
            [config.connectedParam ?? "connected"]: name,
          });
        }
        return redirect(res.authorizationUrl);
      }

      // GET connections/:name/callback → finish OAuth, then redirect. It does
      // NOT resume a waiting turn: the browser must not sit on a blank page
      // for a whole run. Resuming is the CLIENT's job after the redirect —
      // find the pending `connect_<name>` approval in the chat's history and
      // submit it to `POST agents/:agent/:id/approvals`, which returns the
      // continuation stream. See the "OAuth callback identity" section of the
      // package README for the full client protocol.
      if (name && action === "callback" && method === "GET") {
        if (!oauth) return json({ error: `not an OAuth connection: ${name}` }, 400);
        const code = url.searchParams.get("code");
        const rawState = url.searchParams.get("state");
        const returnTo = (callbackState?.returnTo as string) ?? "/";
        if (!code) return redirectTo(returnTo, { error: "missing_code" });
        try {
          await oauth.finish(principal, { code, state: rawState ?? undefined });
        } catch (e) {
          // Surface the real cause — token exchange failures (redirect_uri
          // mismatch, bad secret, resource/scope rejection) are otherwise
          // invisible behind the redirect.
          console.warn(
            `OAuth callback "${name}" token exchange failed:`,
            e instanceof Error ? (e.stack ?? e.message) : e,
          );
          return redirectTo(returnTo, { error: "exchange_failed" });
        }
        await config.onConnected?.(principal, name);
        // Redirect back IMMEDIATELY — don't run the resumed turn here, or the
        // browser would block on a blank page until the whole answer (tool calls
        // + generation) finished. The chat page approves the pending
        // `connect_<name>` on return, so the conversation renders at once and
        // the answer streams/fills in with a working state.
        return redirectTo(returnTo, {
          [config.connectedParam ?? "connected"]: name,
        });
      }

      // POST connections/:name/disconnect → drop credentials
      if (name && action === "disconnect" && method === "POST") {
        await oauth?.provider(principal).invalidateCredentials?.("all");
        return json({ ok: true });
      }

      // POST connections/:name/test → connectivity probe (tool names)
      if (name && action === "test" && method === "POST") {
        try {
          return json({ tools: await conns.testTools(name, principal) });
        } catch (e) {
          notifyError(config.onError, e, { route: "connections.test", name });
          return json(connectionFailure(e, "test failed"), 502);
        }
      }
    }

    // --- runtime ops ------------------------------------------------------
    if (seg[0] === "agents") {
      const principal = await resolveContext(request);
      if (!principal) return json({ error: "unauthorized" }, 401);
      const rt = await resolveRuntime(principal);
      // GET agents — the agents available to the caller (for a picker).
      // Hidden (internal) agents stay resolvable by name but are dropped here;
      // callers that need the full set use `runtime.listAgents()` directly.
      if (!seg[1] && method === "GET") {
        const all = await rt.listAgents(principal);
        return json({ agents: all.filter((a) => !a.hidden) });
      }
      const agent = seg[1];
      // Client-chosen chat id, used as-is. Tenant isolation is enforced by the
      // storage scope (orgId on the row + scoped reads), so it isn't prefixed —
      // and the same id flows through the UI, history, and OAuth-resume links.
      const chatId = seg[2];
      if (!agent || !chatId) return undefined;

      // POST agents/:agent/:id/approvals
      if (seg[3] === "approvals" && method === "POST") {
        const body = (await request.json().catch(() => ({}))) as {
          decisions?: ApprovalDecision[];
        };
        try {
          return await rt.applyApproval({
            chatId,
            principal,
            decisions: Array.isArray(body.decisions) ? body.decisions : [],
            request,
            // The body was consumed above — hand the parsed payload on so
            // context.build never needs to re-read the spent Request.
            turnContext: body,
          });
        } catch (e) {
          // A decision is a turn too: it can meet a busy chat (two clicks) or a
          // spent budget, and must answer 409/429 like a message does.
          const refused = refusalResponse(e);
          if (refused) return refused;
          throw e;
        }
      }

      // POST agents/:agent/:id/tool-result  (client-handled tool, e.g. askUser)
      if (seg[3] === "tool-result" && method === "POST") {
        const body = (await request.json().catch(() => ({}))) as {
          toolCallId?: string;
          output?: unknown;
        };
        if (!body.toolCallId) return json({ error: "toolCallId is required" }, 400);
        try {
          return await rt.applyToolResult({
            chatId,
            principal,
            toolCallId: body.toolCallId,
            output: body.output,
            request,
            // See the approvals route: the parsed body doubles as turnContext.
            turnContext: body,
          });
        } catch (e) {
          const refused = refusalResponse(e);
          if (refused) return refused;
          throw e;
        }
      }

      // POST agents/:agent/:id
      if (!seg[3] && method === "POST") {
        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        try {
          return await rt.handleChat({
            agent,
            chatId,
            principal,
            message: toUserMessage(body),
            request,
            // The POST body is parsed exactly once, here — pass it on as the
            // per-turn payload so `context.build` / agent factories can read
            // request-scoped fields without touching the spent Request body.
            turnContext: body,
          });
        } catch (e) {
          const refused = refusalResponse(e);
          if (refused) return refused;
          throw e;
        }
      }
    }

    if (seg[0] === "chats" && method === "GET") {
      const principal = await resolveContext(request);
      if (!principal) return json({ error: "unauthorized" }, 401);
      const rt = await resolveRuntime(principal);
      const id = seg[1];
      if (id) {
        return json({ messages: await rt.loadHistory({ chatId: id, principal }) });
      }
      return json({ chats: await rt.listChats({ principal }) });
    }

    if (seg[0] === "runs" && method === "GET") {
      const principal = await resolveContext(request);
      if (!principal) return json({ error: "unauthorized" }, 401);
      const rt = await resolveRuntime(principal);
      // `identity` is the serialized Principal — durable SERVER state, and a
      // customer type the docs invite you to extend (plan tier, impersonation
      // markers, support-actor ids). It has no business in a browser payload,
      // so this projection drops it. Read it server-side via `listRuns` if you
      // need it.
      const runs = (await rt.listRuns({ principal })).map(({ identity: _identity, ...run }) => run);
      return json({ runs });
    }

    // --- schedules (cron-driven agents) -----------------------------------
    if (seg[0] === "schedules") {
      const principal = await resolveContext(request);
      if (!principal) return json({ error: "unauthorized" }, 401);
      const rt = await resolveRuntime(principal);
      const id = seg[1];
      if (!id && method === "GET") {
        return json({ schedules: await rt.listSchedules({ principal }) });
      }
      if (!id && method === "POST") {
        const body = (await request.json().catch(() => ({}))) as {
          agent?: string;
          cron?: string | null;
          timezone?: string;
          prompt?: string;
          delivery?: unknown;
          onParked?: unknown;
        };
        if (!body.agent || !body.prompt) {
          return json({ error: "agent and prompt are required" }, 400);
        }
        // Reject an unknown policy rather than silently defaulting it: a
        // caller that meant "fire" and typo'd must not get "skip" plus a 200.
        if (
          body.onParked !== undefined &&
          body.onParked !== "skip" &&
          body.onParked !== "fire"
        ) {
          return json({ error: 'onParked must be "skip" or "fire"' }, 400);
        }
        try {
          const record = await rt.schedule({
            principal,
            agent: body.agent,
            cron: body.cron ?? null,
            timezone: body.timezone,
            prompt: body.prompt,
            // Host-interpreted, opaque to core (see `RuntimeConfig.runSchedule`).
            // Forwarded verbatim — dropping it silently made the whole delivery
            // seam unreachable through this handler.
            delivery: body.delivery,
            onParked: body.onParked as "skip" | "fire" | undefined,
          });
          return json({ schedule: record });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "schedule failed" }, 400);
        }
      }
      // GET schedules/:id — owner-scoped read. Filtered from the caller's own
      // list, so another tenant's id is indistinguishable from a missing one.
      if (id && !seg[2] && method === "GET") {
        const found = (await rt.listSchedules({ principal })).find((sch) => sch.id === id);
        if (!found) return json({ error: "not found" }, 404);
        return json({ schedule: found });
      }
      // POST schedules/:id/run-now — arm it for the next tick. Deliberately
      // NOT a direct fire: it goes through the ordinary runDue path (same
      // claim, same occurrence consume, same delivery), so "run now" can't
      // drift from what the cron actually does.
      if (id && seg[2] === "run-now" && method === "POST") {
        const armed = await rt.runScheduleNow({ principal, id });
        if (!armed) return json({ error: "not found, or already spent" }, 404);
        return json({ ok: true });
      }
      if (id && !seg[2] && method === "DELETE") {
        await rt.unschedule({ principal, id });
        return json({ ok: true });
      }
    }

    // POST cron/run — system-wide tick: fire ALL tenants' due schedules, then
    // reap + resume stalled runs. Host-guarded by `cronSecret`, NOT user auth.
    // Disabled if no secret set.
    if (seg[0] === "cron" && seg[1] === "run" && method === "POST") {
      if (!config.cronSecret) return json({ error: "cron route disabled" }, 404);
      if (request.headers.get("x-latch-cron-secret") !== config.cronSecret) {
        return json({ error: "forbidden" }, 403);
      }
      // Host-supplied tick first — the only option for a resolver-based
      // (DB-per-tenant) setup, where no principal exists to resolve a runtime.
      if (config.cronRun) return json(await config.cronRun());
      if (typeof runtime === "function") {
        return json(
          { error: "cron/run requires a static runtime or a `cronRun` tick in the handler config" },
          400,
        );
      }
      return json(await runtime.cron());
    }

    return undefined;
  };
}
