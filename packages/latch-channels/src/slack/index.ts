/**
 * @intentface/latch-channels/slack
 *
 * The Slack adapter: `slackChannel(...)` drives one agent's dedicated app
 * (own-app-per-agent), plus the manifest generator and the building blocks.
 * All hand-rolled Block Kit, no Chat SDK runtime dependency.
 */
export { slackChannel } from "./slackChannel.js";
export type {
  SlackChannelConfig,
  SlackRunOps,
  SlackTenant,
  SlackPeek,
} from "./slackChannel.js";
export { slackManifest, createFromManifestUrl, SLACK_BOT_SCOPES } from "./manifest.js";
export type { SlackManifestInput } from "./manifest.js";
export { verifySlackSignature } from "./verify.js";
export { slackApi } from "./api.js";
export type { SlackClient, SlackToken } from "./api.js";
export {
  toMrkdwn,
  textBlocks,
  approvalBlocks,
  approvalResolvedBlocks,
  connectBlocks,
  decodeApprovalAction,
  APPROVE_ACTION,
  DENY_ACTION,
} from "./blocks.js";
export type { ApprovalRef } from "./blocks.js";
