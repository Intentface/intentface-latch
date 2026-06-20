import { createServerFn } from "@tanstack/react-start";
import type { AppMessage } from "@intentface/latch-core";
import { getPrincipal } from "./session";
import { getLatch } from "./latch";

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
