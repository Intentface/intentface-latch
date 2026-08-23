/**
 * Generate the Slack **app manifest** for a single agent's dedicated app. Used
 * both ways: posted to `apps.manifest.create` (config-token / "one-button"
 * flow), or shown to the user with a "Create from manifest" deep-link (manual
 * flow). One app per agent → its own bot user and @-handle.
 */

export interface SlackManifestInput {
  /** Display name + handle of the bot (the agent's title). */
  displayName: string;
  /** Short description shown in Slack's app directory. */
  description?: string;
  /** The single webhook URL Slack sends events + interactions + commands to. */
  requestUrl: string;
  /** OAuth redirect URL (the install callback) — required for install flow. */
  redirectUrl?: string;
}

/** Bot scopes for the supported feature set (mentions, DMs, posting, status). */
export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "chat:write.customize",
  "im:history",
  "im:read",
  "im:write",
  "channels:history",
  // List public channels — pickers and the mirage sandbox's read-only /slack
  // mount (its transport guard forces types=public_channel regardless).
  "channels:read",
  "groups:history",
  // Membership checks on private channels for the requester-visibility gate
  // (conversations.members). Listing stays public-only above.
  "groups:read",
  // Reserved for a later per-binding "auto-join public channels" opt-in —
  // granted now so enabling it won't need a reinstall.
  "channels:join",
  "assistant:write",
  "commands",
];
const BOT_SCOPES = SLACK_BOT_SCOPES;

/**
 * Slack's "short description" limit as the CREATE-APP WIZARD enforces it. The
 * manifest reference documents 140 for `display_information.description`, but
 * the wizard rejects a 124-char description as "too long" (observed live) and
 * leaves its confirm button disabled until it fits — the app-listing limit of
 * 100 is the one that actually gates creation. Trimmed at a word boundary so a
 * long agent description doesn't get cut mid-word.
 */
const DESCRIPTION_MAX = 100;

function trimDescription(text: string): string {
  if (text.length <= DESCRIPTION_MAX) return text;
  let cut = text.slice(0, DESCRIPTION_MAX - 1);
  // Never end the cut on a high surrogate — slicing inside an astral pair
  // (an emoji, say) would ship a lone surrogate in the manifest.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  // Break at the LAST whitespace of any kind (newlines, tabs, NBSP — not just
  // spaces), unless that would give up more than half the budget.
  const lastWs = /\s\S*$/.exec(cut)?.index ?? -1;
  return `${(lastWs > DESCRIPTION_MAX / 2 ? cut.slice(0, lastWs) : cut).trimEnd()}…`;
}

/** Build the Slack manifest object (JSON-serializable). */
export function slackManifest(input: SlackManifestInput): Record<string, unknown> {
  const name = input.displayName.slice(0, 35); // Slack app name limit.
  return {
    display_information: {
      name,
      description: trimDescription(input.description ?? `${name} on Latch`),
    },
    features: {
      bot_user: { display_name: name, always_online: true },
      // Agent Sessions (the "Agents" pane). Replaces the deprecated
      // assistant_view (sunset Feb 2027); Slack treats the flip as ONE-WAY.
      agent_view: { agent_description: `Chat with ${name}`.slice(0, 200) },
    },
    oauth_config: {
      ...(input.redirectUrl ? { redirect_urls: [input.redirectUrl] } : {}),
      scopes: { bot: BOT_SCOPES },
    },
    settings: {
      event_subscriptions: {
        request_url: input.requestUrl,
        // message.channels/groups power thread-following (continue without
        // re-@-mentioning); mentions still come via app_mention. Subscribing
        // to agent_session_stopped is what makes the native Stop button
        // appear; tokens_revoked/app_uninstalled let the host disable dead
        // bindings instead of erroring forever.
        bot_events: [
          "app_mention",
          "message.im",
          "message.channels",
          "message.groups",
          "app_home_opened",
          "app_context_changed",
          "agent_session_stopped",
          "agent_session_title_changed",
          "tokens_revoked",
          "app_uninstalled",
        ],
      },
      interactivity: { is_enabled: true, request_url: input.requestUrl },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
    },
  };
}

/** A pre-filled "Create New App → From a manifest" deep-link for the manual flow. */
export function createFromManifestUrl(manifest: Record<string, unknown>): string {
  const json = encodeURIComponent(JSON.stringify(manifest));
  return `https://api.slack.com/apps?new_app=1&manifest_json=${json}`;
}
