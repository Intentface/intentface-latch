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
 *   GET  schedules                      list the tenant's scheduled agents
 *   POST schedules                      create one ({agent, cron, prompt})
 *   DELETE schedules/:id                delete one
 *   POST cron/run                       fire ALL due schedules (host-guarded, no user auth)
 *   GET  connections                    per-connection status for the tenant
 *   GET  connections/:name/authorize    begin OAuth → 302 to the IdP
 *   GET  connections/:name/callback     finish OAuth (+ resume a waiting chat)
 *   POST connections/:name/disconnect   drop the tenant's stored credentials
 *   POST connections/:name/test         open the connection, list its tools
 */
export interface LatchHandlerConfig<P> {
  runtime: Runtime<P>;
  /** Map a request to a Principal (your existing auth). Null → 401. */
  resolveContext: (request: Request) => P | null | Promise<P | null>;
  /** Connection registry (enables the connection routes). */
  connections?: McpConnections<P>;
  /** Path prefix the handler is mounted under (e.g. "/api/latch"). Default "/". */
  basePath?: string;
  /**
   * Shared secret guarding `POST /cron/run` (the system-wide schedule tick).
   * When set, the request must send it as `x-latch-cron-secret`. That route is
   * NOT user-authed — it fires all tenants' due schedules — so guard it at the
   * host (cron secret / network). Omit to disable the route entirely.
   */
  cronSecret?: string;
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

      // GET connections → status list
      if (!name && method === "GET") {
        const principal = await resolveContext(request);
        if (!principal) return json({ error: "unauthorized" }, 401);
        return json({ connections: await connections.status(principal) });
      }

      const action = seg[2];
      const oauth = name ? connections.oauth(name) : undefined;

      // GET connections/:name/authorize → 302 to IdP
      if (name && action === "authorize" && method === "GET") {
        const principal = await resolveContext(request);
        if (!principal) return json({ error: "unauthorized" }, 401);
        if (!oauth) return json({ error: `not an OAuth connection: ${name}` }, 400);
        const chatId = url.searchParams.get("chatId") ?? undefined;
        const approvalId = url.searchParams.get("approvalId") ?? undefined;
        const returnTo = url.searchParams.get("returnTo") ?? undefined;
        const state =
          chatId || approvalId || returnTo
            ? { chatId, approvalId, returnTo }
            : undefined;
        const res = await oauth.start(principal, { state });
        return redirect(
          res.status === "redirect" ? res.authorizationUrl : (returnTo ?? "/"),
        );
      }

      // GET connections/:name/callback → finish OAuth, resume a waiting chat
      if (name && action === "callback" && method === "GET") {
        const principal = await resolveContext(request);
        if (!principal) return json({ error: "unauthorized" }, 401);
        if (!oauth) return json({ error: `not an OAuth connection: ${name}` }, 400);
        const code = url.searchParams.get("code");
        const rawState = url.searchParams.get("state");
        const ctx = decodeOAuthState(rawState);
        const returnTo = (ctx?.returnTo as string) ?? "/";
        if (!code) return redirect(`${returnTo}?error=missing_code`);
        try {
          await oauth.finish(principal, { code, state: rawState ?? undefined });
        } catch {
          return redirect(`${returnTo}?error=exchange_failed`);
        }
        // Redirect back IMMEDIATELY — don't run the resumed turn here, or the
        // browser would block on a blank page until the whole answer (tool calls
        // + generation) finished. The chat page approves the pending
        // `connect_<name>` on return (`?connected=<name>`), so the conversation
        // renders at once and the answer streams/fills in with a working state.
        return redirect(`${returnTo}?connected=${name}`);
      }

      // POST connections/:name/disconnect → drop credentials
      if (name && action === "disconnect" && method === "POST") {
        const principal = await resolveContext(request);
        if (!principal) return json({ error: "unauthorized" }, 401);
        await oauth?.provider(principal).invalidateCredentials?.("all");
        return json({ ok: true });
      }

      // POST connections/:name/test → connectivity probe (tool names)
      if (name && action === "test" && method === "POST") {
        const principal = await resolveContext(request);
        if (!principal) return json({ error: "unauthorized" }, 401);
        try {
          return json({ tools: await connections.testTools(name, principal) });
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
        return runtime.applyApproval({
          chatId,
          principal,
          decisions: Array.isArray(body.decisions) ? body.decisions : [],
          request,
        });
      }

      // POST agents/:agent/:id
      if (!seg[3] && method === "POST") {
        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        return runtime.handleChat({
          agent,
          chatId,
          principal,
          message: toUserMessage(body),
          request,
        });
      }
    }

    if (seg[0] === "chats" && method === "GET") {
      const principal = await resolveContext(request);
      if (!principal) return json({ error: "unauthorized" }, 401);
      const id = seg[1];
      if (id) {
        return json({ messages: await runtime.loadHistory({ chatId: id, principal }) });
      }
      return json({ chats: await runtime.listChats({ principal }) });
    }

    if (seg[0] === "runs" && method === "GET") {
      const principal = await resolveContext(request);
      if (!principal) return json({ error: "unauthorized" }, 401);
      return json({ runs: await runtime.listRuns({ principal }) });
    }

    // --- schedules (cron-driven agents) -----------------------------------
    if (seg[0] === "schedules") {
      const principal = await resolveContext(request);
      if (!principal) return json({ error: "unauthorized" }, 401);
      const id = seg[1];
      if (!id && method === "GET") {
        return json({ schedules: await runtime.listSchedules({ principal }) });
      }
      if (!id && method === "POST") {
        const body = (await request.json().catch(() => ({}))) as {
          agent?: string;
          cron?: string | null;
          prompt?: string;
        };
        if (!body.agent || !body.prompt) {
          return json({ error: "agent and prompt are required" }, 400);
        }
        try {
          const record = await runtime.schedule({
            principal,
            agent: body.agent,
            cron: body.cron ?? null,
            prompt: body.prompt,
          });
          return json({ schedule: record });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "schedule failed" }, 400);
        }
      }
      if (id && method === "DELETE") {
        await runtime.unschedule({ principal, id });
        return json({ ok: true });
      }
    }

    // POST cron/run — system-wide tick (fires ALL tenants' due schedules).
    // Host-guarded by `cronSecret`, NOT user auth. Disabled if no secret set.
    if (seg[0] === "cron" && seg[1] === "run" && method === "POST") {
      if (!config.cronSecret) return json({ error: "cron route disabled" }, 404);
      if (request.headers.get("x-latch-cron-secret") !== config.cronSecret) {
        return json({ error: "forbidden" }, 403);
      }
      return json(await runtime.runDue());
    }

    return undefined;
  };
}
