/**
 * Channel-scope guard for Slack-triggered turns (a `ToolGuard` — see
 * `@intentface/latch-core/tool-guard`).
 *
 * A turn that started from a Slack mention is scoped to the channel it was
 * mentioned in: the agent may never read or post anywhere else. In strict v1
 * the model has NO Slack tools at all — this guard is belt and braces on top of
 * that removal, so the scope survives a tool being re-attached later, and it
 * holds inside delegated subagents (scope comes from the tree's root chat).
 *
 * Every decision — allow and deny — is reported to the audit sink as a
 * `tool_call`, which is how "log every tool call" is satisfied for Slack turns.
 */
import type { ToolGuard, ToolGuardCall } from "@intentface/latch-core";
import { parseSlackChatId } from "./ids.js";
import type { SlackAuditSink } from "./audit.js";

/** The model-facing Slack tools strict v1 removed; denied by name if they ever return. */
export const REMOVED_SLACK_TOOLS: readonly string[] = [
  "slack_read_thread",
  "slack_read_channel",
  "slack_list_channels",
  "post_to_channel",
];

/** Slack conversation ids: C… public, G… private/mpim, D… DM — 9–11 chars in practice. */
const SLACK_CHANNEL_ID = /^[CDG][A-Z0-9]{8,10}$/;
/** Top-level input keys that name a Slack channel by convention. */
const CHANNEL_KEYS = ["channel", "channel_id", "channelId"] as const;

const RETRY_NOTE = "This will not succeed on retry.";

/** Every top-level Slack-shaped channel id in a tool's input. */
function channelsInInput(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const out: string[] = [];
  for (const key of CHANNEL_KEYS) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === "string" && SLACK_CHANNEL_ID.test(v)) out.push(v);
  }
  return out;
}

export function slackScopeGuard<P>(opts: { audit?: SlackAuditSink } = {}): ToolGuard<P> {
  return (call: ToolGuardCall<P>) => {
    // Scope by the ORIGINATING chat — a subagent's own `sub_…` id says nothing.
    const scope = parseSlackChatId(call.rootChatId) ?? parseSlackChatId(call.chatId);
    if (!scope) return { allow: true };

    let reason: string | undefined;
    let offending: string | undefined;
    if (REMOVED_SLACK_TOOLS.includes(call.tool)) {
      reason = `The tool ${call.tool} is not available in Slack conversations: this agent works only inside <#${scope.channel}>. ${RETRY_NOTE}`;
    } else {
      offending = channelsInInput(call.input).find((c) => c !== scope.channel);
      if (offending) {
        reason = `This conversation is scoped to <#${scope.channel}>; the agent cannot read or post in <#${offending}>. ${RETRY_NOTE}`;
      }
    }

    if (opts.audit) {
      try {
        const p = opts.audit({
          action: "tool_call",
          decision: reason ? "deny" : "allow",
          ...(reason ? { reason: offending ? "off_channel" : "removed_tool" } : {}),
          appId: scope.app,
          channelId: scope.channel,
          threadRoot: scope.root,
          chatId: call.rootChatId,
          runId: call.runId,
          meta: { tool: call.tool, ...(offending ? { channel: offending } : {}) },
        });
        if (p && typeof (p as Promise<unknown>).catch === "function") {
          (p as Promise<unknown>).catch((e) => console.error("[slack-guard] audit failed:", e));
        }
      } catch (e) {
        console.error("[slack-guard] audit failed:", e);
      }
    }
    return reason ? { allow: false, reason } : { allow: true };
  };
}
