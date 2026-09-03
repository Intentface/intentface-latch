import { HEARTBEAT_PROMPT, TICK_PROMPT } from "./agent.js";
import type { Principal } from "./principal.js";
import type { Slack } from "./slack.js";
import type { StateStore } from "./state.js";
import type { Triage } from "./triage.js";

/** The channel's one long-lived chat: its monologue. */
export const chatIdOf = (channel: string) => `ambient_${channel}`;

export interface TickRuntime {
  runAgent(input: { principal: Principal; agent: string; prompt: string; threadId: string; blockGated: boolean }): Promise<unknown>;
  loadHistory(input: { chatId: string; principal: Principal }): Promise<unknown[]>;
  compactChat(input: { chatId: string; principal: Principal; focus?: string }): Promise<{ compacted: number } | null>;
}

export interface TickDeps {
  runtime: TickRuntime;
  state: StateStore;
  triage: Triage;
  slack: Pick<Slack, "setThinking">;
  compactAfter: number;
  log?: (line: string) => void;
  now?: () => number;
}

/**
 * One more turn of the channel's monologue: a tick when the inbox has events
 * worth it (triage decides), a heartbeat when the ticker fires on an empty
 * inbox. Returns true when more arrived meanwhile. Every caller goes through
 * the ticker, so a channel never runs two at once.
 *
 * While a mention is being handled, its thread shows Slack's native
 * "thinking" status — set before the run, cleared after, whatever the agent
 * decided to do.
 */
export function createTick(deps: TickDeps) {
  const log = deps.log ?? console.log;
  const now = deps.now ?? Date.now;

  return async function tick(channel: string): Promise<boolean> {
    const principal: Principal = { channel };
    const { events, oldestReceivedAt } = await deps.state.peek(channel);
    let prompt = HEARTBEAT_PROMPT;
    if (events.length > 0) {
      const verdict = await deps.triage.decide({
        channel,
        events,
        stateDoc: (await deps.state.load(channel)).doc,
        oldestAgeMs: oldestReceivedAt ? now() - oldestReceivedAt : 0,
      });
      await deps.state.logTriage(channel, { ...verdict, events: events.length, ...verdict.usage });
      if (!verdict.act) {
        log(`[ambient] ${channel}: deferred ${events.length} event(s) — ${verdict.reason}`);
        return false;
      }
      prompt = TICK_PROMPT;
    }

    // Threads where someone tagged us: show "thinking" while we work.
    const thinking = [...new Set(events.filter((e) => e.kind === "mention").map((e) => (e.kind === "mention" && e.threadTs) || e.ts))];
    await Promise.all(thinking.map((t) => deps.slack.setThinking(channel, t, true)));
    try {
      await deps.runtime.runAgent({ principal, agent: "watcher", prompt, threadId: chatIdOf(channel), blockGated: false });
    } finally {
      await Promise.all(thinking.map((t) => deps.slack.setThinking(channel, t, false)));
    }

    // Keep the monologue bounded: fold old thinking into a summary; the state document carries the facts.
    const history = await deps.runtime.loadHistory({ chatId: chatIdOf(channel), principal });
    if (history.length >= deps.compactAfter) {
      const r = await deps.runtime.compactChat({
        chatId: chatIdOf(channel),
        principal,
        focus: "Keep what you were watching and why; the state document holds the facts.",
      });
      if (r) log(`[ambient] ${channel}: monologue compacted (${r.compacted} messages)`);
    }
    return (await deps.state.pending(channel)) > 0;
  };
}
