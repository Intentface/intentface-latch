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
  /** Optional slash command (e.g. "latch") → same request URL. */
  slashCommand?: string;
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
  "groups:history",
  "assistant:write",
  "commands",
];
const BOT_SCOPES = SLACK_BOT_SCOPES;

/** Build the Slack manifest object (JSON-serializable). */
export function slackManifest(input: SlackManifestInput): Record<string, unknown> {
  const name = input.displayName.slice(0, 35); // Slack app name limit.
  return {
    display_information: {
      name,
      description: (input.description ?? `${name} on Latch`).slice(0, 140),
    },
    features: {
      bot_user: { display_name: name, always_online: true },
      assistant_view: { assistant_description: `Chat with ${name}`.slice(0, 200) },
      ...(input.slashCommand
        ? {
            slash_commands: [
              {
                command: `/${input.slashCommand}`,
                url: input.requestUrl,
                description: `Talk to ${name}`,
                should_escape: false,
              },
            ],
          }
        : {}),
    },
    oauth_config: {
      ...(input.redirectUrl ? { redirect_urls: [input.redirectUrl] } : {}),
      scopes: { bot: BOT_SCOPES },
    },
    settings: {
      event_subscriptions: {
        request_url: input.requestUrl,
        // message.channels/groups power thread-following (continue without
        // re-@-mentioning); mentions still come via app_mention.
        bot_events: [
          "app_mention",
          "message.im",
          "message.channels",
          "message.groups",
          "assistant_thread_started",
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
