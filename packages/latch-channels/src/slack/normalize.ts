/**
 * Inbound message normalization — what the model sees of a Slack message.
 *
 * Slack text arrives with mrkdwn tokens (`<@U…>`, `<#C…|name>`, `<url|label>`)
 * and HTML-escaped entities. v1 only stripped a LEADING bot mention and used a
 * `<@` substring test to gate thread replies — so mentioning a colleague
 * mid-message silently dropped the message. v2 rewrites every token to a plain
 * representation and gates on message shape, never on text content.
 *
 * No `users:read` scope: a user mention without an inline label renders as the
 * raw id (`@U123`) — a stable handle the model can echo back, which the
 * outbound side re-links.
 */

/** Subtypes that still carry a human message worth running a turn for. */
const SUBTYPE_ALLOWLIST = new Set(["file_share", "thread_broadcast"]);

/**
 * Turn Slack mrkdwn source text into plain prompt text.
 * Bot self-mentions vanish; everything else stays human-readable.
 */
export function normalizeSlackText(text: string, botUserId?: string): string {
  let out = text;

  // User mentions: `<@U123|display>` → `@display`, `<@U123>` → `@U123`;
  // the bot's own mention (anywhere, not just leading) is removed.
  out = out.replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => {
    if (botUserId && id === botUserId) return "";
    return `@${label || id}`;
  });

  // Channel references and broadcast keywords.
  out = out.replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => {
    return `#${label || id}`;
  });
  out = out.replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1");

  // Links: `<url|label>` → `label (url)`, `<url>` → `url`.
  out = out.replace(/<((?:https?|mailto):[^>|]*)\|([^>]*)>/g, "$2 ($1)");
  out = out.replace(/<((?:https?|mailto):[^>|]*)>/g, "$1");

  // Entities LAST — the token forms above use raw angle brackets, escaped
  // `&lt;` in user text must not become parseable tokens first.
  out = out.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

  // Removed mentions leave double spaces behind; collapse within lines only.
  return out.replace(/[^\S\n]{2,}/g, " ").trim();
}

/**
 * Is this `message`/`app_mention` event a human message the channel should
 * consider running a turn for? Shape checks only — the caller layers admission
 * (dedupe, ownership, authorization) on top.
 *
 * The subtype ALLOWLIST replaces v1's blanket `!subtype` + separate
 * `bot_message` checks: everything not explicitly allowed (edits, joins,
 * bot_message, channel_topic, …) is out. The only self-check is the bot user
 * id — v2 requires hosts to know it (captured at install), so the weaker
 * `bot_id`-presence heuristic covers other bots, not identity.
 */
export function isRenderableUserMessage(
  ev: { user?: string; subtype?: string; bot_id?: string },
  botUserId: string,
): boolean {
  if (ev.bot_id) return false;
  if (ev.subtype && !SUBTYPE_ALLOWLIST.has(ev.subtype)) return false;
  if (!ev.user || ev.user === botUserId) return false;
  return true;
}
