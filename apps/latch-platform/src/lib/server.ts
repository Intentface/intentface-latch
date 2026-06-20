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

/** The registered agents (name + display metadata), for the picker. */
export const listAgentsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { runtime } = await getLatch();
  return runtime.listAgents();
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
