import type { Observation } from "./state.js";

/**
 * "Am I in this conversation?" Once the agent has spoken, follow-ups deserve an
 * answer at a much lower bar — socially you do not go quiet after replying.
 * A message follows the agent when it is a reply in a thread the agent posted
 * in, or a top-level message within `windowMs` of the agent's last top-level
 * post. A message addresses the agent when it @-mentions it or uses its name.
 */
export interface Engagement {
  /** Thread roots the agent has posted in (a top-level post is its own root). */
  threads: Set<string>;
  /** Slack ts of the agent's most recent top-level post, or null. */
  lastTopLevelTs: number | null;
  /** The bot's display name / handle, for "Ambient, …" without an @. */
  botName: string;
}

export const ENGAGED_WINDOW_MS = 30 * 60_000;

export function engagementOf(posts: { ts: string; threadTs?: string }[], botName: string): Engagement {
  const threads = new Set<string>();
  let lastTopLevelTs: number | null = null;
  for (const p of posts) {
    threads.add(p.threadTs ?? p.ts);
    if (!p.threadTs) lastTopLevelTs = Math.max(lastTopLevelTs ?? 0, Number(p.ts));
  }
  return { threads, lastTopLevelTs, botName };
}

export function followsMe(o: Observation, e: Engagement, windowMs = ENGAGED_WINDOW_MS): boolean {
  if (o.kind !== "message" && o.kind !== "reply" && o.kind !== "mention") return false;
  if (o.threadTs) return e.threads.has(o.threadTs);
  return e.lastTopLevelTs !== null && Number(o.ts) - e.lastTopLevelTs <= windowMs / 1000 && Number(o.ts) > e.lastTopLevelTs;
}

export function addressesMe(o: Observation, e: Engagement): boolean {
  if (o.kind === "mention") return true;
  if (o.kind !== "message" && o.kind !== "reply") return false;
  if (!e.botName) return false;
  return new RegExp(`(^|[^\\w])${e.botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w]|$)`, "i").test(o.text);
}
