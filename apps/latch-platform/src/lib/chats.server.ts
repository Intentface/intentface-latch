import { createServerFn } from "@tanstack/react-start";
import type { AppMessage } from "@intentface/latch-core";
import { getPrincipal } from "./session";
import { getLatch } from "./latch";

/** Server-side auth check (sees the cookie during SSR) for route guards. */
export const currentPrincipalFn = createServerFn({ method: "GET" }).handler(
  async () => {
    const p = await getPrincipal();
    // Return only serializable fields (Principal.meta is unknown-typed).
    return p ? { orgId: p.orgId, userId: p.userId } : null;
  },
);

/** The tenant's chats for the sidebar (id, title, agent, updatedAt). */
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

/**
 * Client-projected history for one chat (used as useChat initial messages).
 * UIMessages are JSON at runtime but their `parts` carry `unknown` fields the
 * server-fn serializer can't statically verify, so we cast at the boundary.
 */
export const loadHistoryFn = createServerFn({ method: "GET" })
  .inputValidator((chatId: string) => chatId)
  .handler(async ({ data: chatId }) => {
    const principal = await getPrincipal();
    if (!principal) return [] as AppMessage[];
    const { runtime } = await getLatch();
    const messages = await runtime.loadHistory({ chatId, principal });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return messages as any;
  });
