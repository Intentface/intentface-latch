/**
 * Chat-id scheme v2 — `slack2_<app>_<channel>_<root>`.
 *
 * One Latch chat is one Slack conversation anchor:
 *
 *   slack2_A123_C456_1712345678.000100   a thread (channel thread OR a session
 *                                        in the Agents pane — the pane is just
 *                                        threads in the bot's DM channel)
 *   slack2_A123_D789_dm                  the ONE chat for un-threaded messages
 *                                        in a DM channel — plain DMs keep their
 *                                        history instead of forking a new chat
 *                                        per message
 *
 * The app id is mandatory: two bots in the same channel can never share a chat,
 * by construction. The `agent_session_stopped` event carries `channel` +
 * `thread_ts`, so a stop maps to its chat with a pure function — no reverse
 * index.
 *
 * v1 ids (`slack_…`) deliberately do NOT parse. The v1 scheme had an unscoped
 * legacy form whose "adopt the old chat" fallback carried a documented
 * cross-app hole; v2 is a clean break.
 */

/** Reversible segment escaping: `_` is the id separator, `%` the escape. */
const encodeSeg = (v: string) => v.replace(/%/g, "%25").replace(/_/g, "%5F");
const decodeSeg = (v: string) => v.replace(/%5F/g, "_").replace(/%25/g, "%");

/** Root marker for the per-DM-channel chat (un-threaded messages). */
export const DM_ROOT = "dm";

/** A Slack message timestamp (`1712345678.000100`) — the only other root form. */
const THREAD_ROOT = /^\d+\.\d+$/;

export interface SlackChatRef {
  /** Slack app id (`A…`) — the namespace. */
  app: string;
  /** Slack conversation id (`C…`/`G…`/`D…`). */
  channel: string;
  /** Thread root ts, or {@link DM_ROOT} for the un-threaded DM chat. */
  root: string;
}

/** Build a v2 chat id. Throws on a malformed root — a bad id must never be minted. */
export function slackChatId(app: string, channel: string, root: string): string {
  if (root !== DM_ROOT && !THREAD_ROOT.test(root)) {
    throw new Error(`slack chat id: invalid root ${JSON.stringify(root)}`);
  }
  return `slack2_${encodeSeg(app)}_${encodeSeg(channel)}_${root}`;
}

/**
 * Parse a v2 chat id, or null for anything else — including every v1
 * (`slack_…`) id, which is the clean break.
 */
export function parseSlackChatId(id: string): SlackChatRef | null {
  const m = /^slack2_([^_]+)_([^_]+)_(\d+\.\d+|dm)$/.exec(id);
  if (!m) return null;
  return { app: decodeSeg(m[1]!), channel: decodeSeg(m[2]!), root: m[3]! };
}
