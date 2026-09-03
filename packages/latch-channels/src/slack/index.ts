/**
 * @intentface/latch-channels/slack
 *
 * The Slack adapter, v2: `slackChannel(...)` drives one agent's dedicated app
 * (own-app-per-agent) — agent sessions, native streaming with task cards,
 * initiator-owned threads, atomic turn admission. All hand-rolled Block Kit,
 * no Chat SDK runtime dependency.
 */
export { slackChannel } from "./slackChannel.js";
export type {
  SlackChannelConfig,
  SlackChatMeta,
  SlackTenant,
  SlackThreadStore,
  SlackPeek,
} from "./slackChannel.js";
export { slackScopeGuard, REMOVED_SLACK_TOOLS } from "./guard.js";
export type { SlackAuditAction, SlackAuditEvent, SlackAuditSink } from "./audit.js";
export { slackChatId, parseSlackChatId, DM_ROOT } from "./ids.js";
export type { SlackChatRef } from "./ids.js";
export { normalizeSlackText, isRenderableUserMessage } from "./normalize.js";
export { encodeAction, decodeAction } from "./payloads.js";
export type { ActionPayload } from "./payloads.js";
export { renderSlackStream } from "./stream.js";
export type { SlackStreamOptions, SlackStreamResult } from "./stream.js";
export { slackManifest, createFromManifestUrl, SLACK_BOT_SCOPES } from "./manifest.js";
export type { SlackManifestInput } from "./manifest.js";
export { verifySlackSignature } from "./verify.js";
export { slackApi, SlackApiError } from "./api.js";
export type { SlackClient, SlackToken, SlackApiOptions, StreamChunk } from "./api.js";
export {
  markdownBlocks,
  notificationText,
  approvalBlocksV2,
  approvalResolvedBlocks,
  connectBlocks,
  signInCard,
  errorBlocks,
  feedbackActions,
  contextLine,
  APPROVE_ACTION,
  DENY_ACTION,
  FEEDBACK_ACTION,
} from "./blocks.js";
