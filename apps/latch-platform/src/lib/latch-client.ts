import type { AppMessage } from "@intentface/latch-core";

/**
 * Browser-side client for the mounted Latch handler (`/api/latch`). All Latch
 * operations go through the one handler — no per-endpoint server functions.
 * Cookies ride along automatically (same origin), so the handler resolves the
 * principal from the session.
 */
const BASE = "/api/latch";

/** The chat endpoint for `useChat`'s transport (agent + chatId in the path). */
export const chatApi = (chatId: string, agent: string) =>
  `${BASE}/agents/${agent}/${chatId}`;

/**
 * The URL that starts a connection's OAuth. `chatId`/`approvalId` (in-chat
 * connect) make the callback resume that conversation; omit them for the
 * self-serve Connections page. `returnTo` is where the callback redirects.
 */
export function authorizeUrl(
  name: string,
  opts: { chatId?: string; approvalId?: string; returnTo: string },
): string {
  const q = new URLSearchParams();
  if (opts.chatId) q.set("chatId", opts.chatId);
  if (opts.approvalId) q.set("approvalId", opts.approvalId);
  q.set("returnTo", opts.returnTo);
  return `${BASE}/connections/${name}/authorize?${q}`;
}

/** Submit approval decisions and drive the continuation to completion. */
export async function applyApproval(
  chatId: string,
  agent: string,
  decisions: { approvalId: string; approved: boolean }[],
): Promise<void> {
  const res = await fetch(`${chatApi(chatId, agent)}/approvals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decisions }),
  });
  await res.text(); // consume the stream so the server finishes + persists
}

/** Client-projected history for a chat (used to refresh after an approval). */
export async function loadHistory(chatId: string): Promise<AppMessage[]> {
  const res = await fetch(`${BASE}/chats/${chatId}`);
  const data = (await res.json()) as { messages: AppMessage[] };
  return data.messages;
}

/** Open a connection and list its tools (a connectivity probe). */
export async function testConnection(name: string): Promise<string[]> {
  const res = await fetch(`${BASE}/connections/${name}/test`, { method: "POST" });
  const data = (await res.json()) as { tools?: string[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? "test failed");
  return data.tools ?? [];
}

/** Drop the tenant's stored credentials for a connection. */
export async function disconnectConnection(name: string): Promise<void> {
  await fetch(`${BASE}/connections/${name}/disconnect`, { method: "POST" });
}

export interface ScheduleSummary {
  id: string;
  agent: string;
  cron: string | null;
  prompt: string;
  nextRunAt: number;
  lastRunAt?: number | null;
  enabled: boolean;
}

/** Create a scheduled agent run (cron null = one-shot, fires on the next tick). */
export async function createSchedule(input: {
  agent: string;
  cron: string | null;
  prompt: string;
}): Promise<void> {
  const res = await fetch(`${BASE}/schedules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? "Failed to create schedule");
  }
}

/** Delete one of the caller's schedules. */
export async function deleteSchedule(id: string): Promise<void> {
  await fetch(`${BASE}/schedules/${id}`, { method: "DELETE" });
}
