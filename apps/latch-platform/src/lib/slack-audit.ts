/**
 * Slack audit event → channel audit row. Shared by the per-app channel wiring
 * (which knows its binding) and the runtime-level scope guard (which only knows
 * the `appId` it parsed from the chat id and resolves the binding itself).
 */
import type { SlackAuditEvent } from "@intentface/latch-channels/slack";
import type { ChannelAuditRecord } from "./channel-audit-store";

export function toChannelAuditRecord(
  e: SlackAuditEvent,
  app?: { orgId: string; agent: string; teamId?: string } | null,
): ChannelAuditRecord {
  return {
    channel: "slack",
    action: e.action,
    decision: e.decision,
    ...(e.reason ? { reason: e.reason } : {}),
    ...(app ? { orgId: app.orgId, agent: app.agent } : {}),
    ...(e.appId ? { appId: e.appId } : {}),
    ...(e.teamId || app?.teamId ? { teamId: e.teamId || app?.teamId } : {}),
    ...(e.channelId ? { externalChannelId: e.channelId } : {}),
    ...(e.threadRoot ? { threadRoot: e.threadRoot } : {}),
    ...(e.slackUserId ? { externalUserId: e.slackUserId } : {}),
    ...(e.chatId ? { chatId: e.chatId } : {}),
    ...(e.runId ? { runId: e.runId } : {}),
    ...(e.meta ? { meta: e.meta } : {}),
  };
}
