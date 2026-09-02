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
   * NOT consulted for identity on the OAuth callback when the flow carries a
   * pinned principal (every flow started by this handler does): the callback
   * rebuilds identity from the flow state via `reconstructPrincipal` instead,
   * so a degraded session at redirect time can never change where credentials
   * land. `extra.oauthState` (the decoded state) is still passed on legacy
   * callbacks whose state predates pinning — deprecated, remove-later.
   */
  resolveContext: (
    request: Request,
    extra?: { oauthState?: Record<string, unknown> },
  ) => P | null | Promise<P | null>;
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
   * Query param appended to the post-callback redirect signalling which
   * connection just connected (`?<connectedParam>=<name>`). Default "connected".
   */
  connectedParam?: string;
  /** Path prefix the handler is mounted under (e.g. "/api/latch"). Default "/". */
  basePath?: string;
  /**
   * Extra query-param names on `connections/:name/authorize` to fold verbatim
   * into the OAuth `state` (alongside the built-in chatId/approvalId/returnTo/
   * scope). Default: none.
   *
   * @deprecated for identity: the resolved principal is now pinned into the
   * flow state automatically and rebuilt on the callback via
   * `reconstructPrincipal` — threading tenant ids through `stateParams` +
   * `extra.oauthState` for that purpose is no longer needed. Still fine for
   * non-identity context a host wants echoed back.
   */
  stateParams?: string[];
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
      const callbackState =
        name && action === "callback" && method === "GET"
          ? (decodeOAuthState(url.searchParams.get("state")) ?? undefined)
          : undefined;

      const pinned = callbackState?.__latch as
        | { p?: unknown; iat?: number }
        | undefined;
      let principal: P | null;
      if (pinned && pinned.p !== undefined && typeof pinned.iat === "number") {
        const maxAge = config.oauthFlowMaxAgeMs ?? 30 * 60_000;
        if (Date.now() - pinned.iat > maxAge) {
          return redirectTo((callbackState?.returnTo as string) ?? "/", {
            error: "flow_expired",
          });
        }
        principal = await (config.reconstructPrincipal ?? ((id) => id as P))(
          pinned.p,
          request,
        );
      } else {
        // Non-callback routes, and legacy callbacks whose state predates
        // pinning (deprecated fallback — remove once in-flight flows drain).
        principal = await resolveContext(
          request,
          callbackState ? { oauthState: callbackState } : undefined,
        );
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
        // callback (which may lack a session) can rebuild it — e.g. a
        // credential-scope selector, plus any consumer-declared `stateParams`
        // (e.g. a tenant id).
        const scope = url.searchParams.get("scope") ?? undefined;
        const extraState: Record<string, string> = {};
        for (const key of config.stateParams ?? []) {
          const value = url.searchParams.get(key);
          if (value !== null) extraState[key] = value;
        }
        // Pin the resolved principal (+ issue time) into the flow state. The
        // callback rebuilds identity from this pin via `reconstructPrincipal`
        // — the live session at redirect time never decides where credentials
        // land. Principals are IDs-only by contract, so the payload is small
        // and non-sensitive; integrity comes from the stored-state exact match.
        const state = {
          ...extraState,
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
          return json({ error: e instanceof Error ? e.message : "authorize failed" }, 400);
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
          return json(
            { error: e instanceof Error ? e.message : "test failed" },
            502,
          );
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
        return rt.applyApproval({
          chatId,
          principal,
          decisions: Array.isArray(body.decisions) ? body.decisions : [],
          request,
          // The body was consumed above — hand the parsed payload on so
          // context.build never needs to re-read the spent Request.
          turnContext: body,
        });
      }

      // POST agents/:agent/:id/tool-result  (client-handled tool, e.g. askUser)
      if (seg[3] === "tool-result" && method === "POST") {
        const body = (await request.json().catch(() => ({}))) as {
          toolCallId?: string;
          output?: unknown;
        };
        if (!body.toolCallId) return json({ error: "toolCallId is required" }, 400);
        return rt.applyToolResult({
          chatId,
          principal,
          toolCallId: body.toolCallId,
          output: body.output,
          request,
          // See the approvals route: the parsed body doubles as turnContext.
          turnContext: body,
        });
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
          // A new message arrived while the previous turn is still awaiting an
          // approval decision. PendingApprovalError carries a stable `code` so
          // we map it to 409 (the client should resolve the pending approval
          // first) instead of letting it bubble to the host as a 500.
          if (
            e &&
            typeof e === "object" &&
            (e as { code?: unknown }).code === "pending_approval"
          ) {
            return json(
              {
                error:
                  e instanceof Error ? e.message : "awaiting approval decision",
                code: "pending_approval",
              },
              409,
            );
          }
          // A client-supplied chat id collided with an existing (typically
          // foreign-owned) chat: the scoped getChat missed, createChat hit the
          // PK. ChatConflictError carries a stable `code` — map it to 409 so
          // the client can pick a different id, instead of a 500.
          if (
            e &&
            typeof e === "object" &&
            (e as { code?: unknown }).code === "chat_conflict"
          ) {
            return json(
              {
                error:
                  e instanceof Error ? e.message : "chat id is not available",
                code: "chat_conflict",
              },
              409,
            );
          }
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
