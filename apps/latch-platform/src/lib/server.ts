import { createServerFn } from "@tanstack/react-start";
import type { AppMessage } from "@intentface/latch-core";
import { getPrincipal } from "./session";
import { getLatch } from "./latch";
import { clockifyScope } from "@/connections/clockify";
import type { CredentialScope } from "./credentials";

/** API-key connections (REST/OpenAPI) and their credential scope, for the key UI. */
const API_KEY_CONNECTIONS: { name: string; label: string; scope: CredentialScope }[] = [
  { name: "clockify", label: "Clockify", scope: clockifyScope },
];

/**
 * Server-only reads for SSR route loaders / auth gates. These are thin
 * pass-throughs to the in-process runtime (the framework does the work) — the
 * idiomatic TanStack way to render server-side, not per-endpoint Latch glue.
 * All Latch *operations* (chat, approvals, connections) go through the mounted
 * handler via `latch-client`, not here.
 */

/** Auth gate: the current principal, or null. */
export const currentPrincipalFn = createServerFn({ method: "GET" }).handler(
  async () => {
    const p = await getPrincipal();
    return p ? { orgId: p.orgId, userId: p.userId } : null;
  },
);

/** The tenant's chats for the sidebar. */
export const listChatsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { runtime } = await getLatch();
  const chats = await runtime.listChats({ principal });
  return chats.map((c) => ({
    id: c.id,
    title: c.title ?? null,
    agent: c.agent,
    updatedAt: c.updatedAt,
  }));
});

/** The tenant's runs (status, tokens, cost) for the ops panel. */
export const listRunsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { runtime } = await getLatch();
  const runs = await runtime.listRuns({ principal });
  return runs.map((r) => ({
    id: r.id,
    chatId: r.chatId,
    agent: r.agent,
    status: r.status,
    inputTokens: r.usageInputTokens ?? 0,
    outputTokens: r.usageOutputTokens ?? 0,
    cost: r.costTotal ?? 0,
    startedAt: r.startedAt,
    endedAt: r.endedAt ?? null,
  }));
});

/** Client-projected history for one chat (useChat initial messages). */
export const loadHistoryFn = createServerFn({ method: "GET" })
  .validator((chatId: string) => chatId)
  .handler(async ({ data: chatId }) => {
    const principal = await getPrincipal();
    if (!principal) return [] as AppMessage[];
    const { runtime } = await getLatch();
    const messages = await runtime.loadHistory({ chatId, principal });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return messages as any;
  });

/** Per-connection status for the Connections page. */
export const connectionsStatusFn = createServerFn({ method: "GET" }).handler(
  async () => {
    const principal = await getPrincipal();
    if (!principal) return [];
    const { connections } = await getLatch();
    return connections.status(principal);
  },
);

/** API-key connection status (is a key stored for the caller, at its scope). */
export const connectionKeysFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { credentials } = await getLatch();
  return Promise.all(
    API_KEY_CONNECTIONS.map(async (c) => ({
      name: c.name,
      label: c.label,
      scope: c.scope,
      set: await credentials.has(principal, c.name, c.scope),
    })),
  );
});

/** Store an API key for a connection, at its declared scope (user/org). */
export const setConnectionKeyFn = createServerFn({ method: "POST" })
  .validator((data: { name: string; value: string }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false };
    const conn = API_KEY_CONNECTIONS.find((c) => c.name === data.name);
    if (!conn) return { ok: false };
    const { credentials } = await getLatch();
    await credentials.set(principal, conn.name, conn.scope, data.value);
    return { ok: true };
  });

/** UI-added connections visible to the caller (org-shared + personal). */
export const listConnectionsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { connectionStore, dynamic } = await getLatch();
  const conns = await connectionStore.list(principal);
  // OAuth status for MCP connections (whether the caller has authorized).
  const status = new Map((await dynamic.status(principal)).map((s) => [s.name, s]));
  // Never return the token to the client — just shape + whether auth is set.
  return conns.map((c) => ({
    name: c.name,
    kind: c.kind,
    scope: c.scope,
    target: c.mcp?.url ?? c.openapi?.spec ?? "",
    hasAuth: c.auth?.kind === "bearer" || c.auth?.kind === "header",
    oauth: c.auth?.kind === "oauth",
    authorized: status.get(c.name)?.authorized ?? true,
  }));
});

/** Add a UI-defined connection (stored encrypted in the Vault at its scope). */
export const addConnectionFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      name: string;
      kind: "mcp" | "openapi";
      scope: "user" | "org";
      url?: string;
      spec?: string;
      baseUrl?: string;
      operations?: string;
      /** MCP only: "oauth" uses the interactive flow (no token); else token/none. */
      authMode?: "none" | "token" | "oauth";
      authHeader?: string;
      token?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false, error: "unauthorized" };
    const name = data.name.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!name) return { ok: false, error: "name required" };
    const auth =
      data.kind === "mcp" && data.authMode === "oauth"
        ? ({ kind: "oauth" } as const)
        : data.token?.trim()
          ? {
              kind: (data.authHeader?.trim() ? "header" : "bearer") as "header" | "bearer",
              header: data.authHeader?.trim() || undefined,
              token: data.token.trim(),
            }
          : undefined;
    const { connectionStore } = await getLatch();
    if (data.kind === "mcp") {
      if (!data.url?.trim()) return { ok: false, error: "url required" };
      await connectionStore.add(principal, data.scope, { kind: "mcp", name, mcp: { url: data.url.trim() }, auth });
    } else {
      if (!data.spec?.trim()) return { ok: false, error: "spec required" };
      const operations = data.operations
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await connectionStore.add(principal, data.scope, {
        kind: "openapi",
        name,
        openapi: {
          spec: data.spec.trim(),
          baseUrl: data.baseUrl?.trim() || undefined,
          operations: operations && operations.length > 0 ? operations : undefined,
        },
        auth,
      });
    }
    return { ok: true };
  });

/** Remove a UI-defined connection at its scope. */
export const removeConnectionFn = createServerFn({ method: "POST" })
  .validator((data: { name: string; scope: "user" | "org" }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false };
    const { connectionStore } = await getLatch();
    await connectionStore.remove(principal, data.scope, data.name);
    return { ok: true };
  });

/** The agents available to the caller (code + UI-created), for the picker. */
export const listAgentsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { runtime } = await getLatch();
  return runtime.listAgents(principal);
});

/** The model catalog (id + label) for the agent editor's dropdown (from models.dev). */
export const listModelsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { models } = await getLatch();
  return models;
});

/** Full UI-created agent records (org + personal), for the editor. */
export const listAgentRecordsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { agentStore } = await getLatch();
  return agentStore.listRecords(principal);
});

/** Connection names an agent can reference (code-declared + the caller's). */
export const availableConnectionNamesFn = createServerFn({ method: "GET" }).handler(
  async () => {
    const principal = await getPrincipal();
    if (!principal) return [];
    const { connections, connectionStore } = await getLatch();
    const stored = (await connectionStore.list(principal)).map((c) => c.name);
    return Array.from(new Set([...connections.names, ...stored]));
  },
);

/**
 * Enumerate the tools of the given connections for the agent editor: each
 * real tool with whether it's gated by default (so the UI pre-seeds the
 * GET-free / mutating-gated default). Opens the connections live — unauthorized
 * OAuth / unreachable ones contribute nothing.
 */
export const connectionToolsFn = createServerFn({ method: "GET" })
  .validator((names: string[]) => names)
  .handler(async ({ data: names }) => {
    const principal = await getPrincipal();
    if (!principal || names.length === 0) return [];
    const { allConnections } = await getLatch();
    const opened = await allConnections.hostFor(names).open(principal);
    try {
      const approval = (opened.toolApproval ?? {}) as Record<string, unknown>;
      return Object.keys(opened.tools)
        .filter((k) => !k.startsWith("connect_"))
        .map((name) => ({
          name,
          connection: names.find((n) => name.startsWith(`${n}_`)) ?? name.split("_")[0],
          defaultApproval: !!approval[name],
        }));
    } finally {
      await opened.close();
    }
  });

/** Create or update a UI agent at its scope. */
export const saveAgentFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      name: string;
      title?: string;
      description?: string;
      modelId: string;
      instructions: string;
      connections: string[];
      maxSteps?: number | "unlimited";
      tools?: { enabled: string[]; approval: Record<string, boolean> };
      exec?: {
        sandbox?: boolean;
        provider?: string;
        defaultTools?: boolean | string[];
        disableTools?: string[];
        codeMode?: { tools?: string[] };
      };
      scope: "user" | "org";
    }) => data,
  )
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false, error: "unauthorized" };
    const name = data.name.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!name) return { ok: false, error: "name required" };
    if (!data.instructions.trim()) return { ok: false, error: "instructions required" };
    const { agentStore } = await getLatch();
    await agentStore.upsert(principal, {
      name,
      title: data.title?.trim() || undefined,
      description: data.description?.trim() || undefined,
      modelId: data.modelId,
      instructions: data.instructions,
      connections: data.connections,
      maxSteps: data.maxSteps,
      tools: data.tools,
      exec: data.exec,
      scope: data.scope,
    });
    return { ok: true };
  });

/** Delete a UI agent at its scope. */
export const deleteAgentFn = createServerFn({ method: "POST" })
  .validator((data: { name: string; scope: "user" | "org" }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false };
    const { agentStore } = await getLatch();
    await agentStore.remove(principal, data.scope, data.name);
    return { ok: true };
  });

/** The caller's scheduled agents, for the Schedules page. */
export const listSchedulesFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { runtime } = await getLatch();
  const schedules = await runtime.listSchedules({ principal });
  return schedules.map((s) => ({
    id: s.id,
    agent: s.agent,
    cron: s.cron,
    prompt: s.prompt,
    nextRunAt: s.nextRunAt,
    lastRunAt: s.lastRunAt ?? null,
    enabled: s.enabled,
  }));
});
