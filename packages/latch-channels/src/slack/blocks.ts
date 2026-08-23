/**
 * Hand-rolled Slack Block Kit builders for the small surface a Latch channel
 * needs. Answer text ships as native `markdown` blocks (Slack renders GFM —
 * headings, tables, fenced code — itself); approval buttons carry SIGNED
 * payloads built in payloads.ts. Hand-rolled to keep the package
 * dependency-free — no Chat SDK runtime.
 */

const SECTION_LIMIT = 2900; // Slack section text hard limit is 3000.

export const APPROVE_ACTION = "latch_approve";
export const DENY_ACTION = "latch_deny";

function truncateJson(value: unknown, max = 2500): string {
  let s: string;
  try {
    s = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    s = String(value);
  }
  return s.length > max ? `${s.slice(0, max)}\n… (truncated)` : s;
}

/** The settled-approval card shown after a decision (replaces the buttons). */
export function approvalResolvedBlocks(toolName: string, approved: boolean): unknown[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: approved
          ? `:white_check_mark: Approved *${toolName}*`
          : `:x: Denied *${toolName}*`,
      },
    },
  ];
}

/** Ephemeral OAuth sign-in prompt for a `connect_<name>` approval. */
export function connectBlocks(connectionName: string, authorizeUrl: string): unknown[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `Connect *${connectionName}* to continue.` },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "latch_connect_noop", // link button: handled by url, no callback
          style: "primary",
          text: { type: "plain_text", text: `Sign in to ${connectionName}` },
          url: authorizeUrl,
        },
      ],
    },
  ];
}

/** Slack's `markdown` block cap. */
export const MARKDOWN_BLOCK_LIMIT = 12_000;

/**
 * Split answer text into native `markdown` blocks — Slack renders headings,
 * tables, fenced code and task lists itself, so the text goes through verbatim.
 * Splits prefer a blank line, then a newline, then a space near the limit, so
 * a boundary almost never lands mid-word (mid-code-fence remains possible for
 * a single 12k+ fence — unsplittable by construction).
 */
export function markdownBlocks(text: string): unknown[] {
  const blocks: unknown[] = [];
  let rest = text;
  while (rest.length > MARKDOWN_BLOCK_LIMIT) {
    const window = rest.slice(0, MARKDOWN_BLOCK_LIMIT);
    const cut = (() => {
      const para = window.lastIndexOf("\n\n");
      if (para > MARKDOWN_BLOCK_LIMIT / 2) return para;
      const line = window.lastIndexOf("\n");
      if (line > MARKDOWN_BLOCK_LIMIT / 2) return line;
      const space = window.lastIndexOf(" ");
      if (space > MARKDOWN_BLOCK_LIMIT / 2) return space;
      return MARKDOWN_BLOCK_LIMIT;
    })();
    blocks.push({ type: "markdown", text: rest.slice(0, cut) });
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  blocks.push({ type: "markdown", text: rest.length ? rest : " " });
  return blocks;
}

/** The plain-notification `text` fallback Slack shows in pings/previews. */
export function notificationText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200) || "New message";
}

/** v2 approval card — same shape as v1 but the button value is a SIGNED payload. */
export function approvalBlocksV2(signedValue: string, toolName: string, input: unknown): unknown[] {
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `:lock: Approve *${toolName}*?` } },
  ];
  if (input !== undefined) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "```" + truncateJson(input) + "```" },
    });
  }
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: APPROVE_ACTION,
        style: "primary",
        text: { type: "plain_text", text: "Approve" },
        value: signedValue,
      },
      {
        type: "button",
        action_id: DENY_ACTION,
        style: "danger",
        text: { type: "plain_text", text: "Deny" },
        value: signedValue,
      },
    ],
  });
  return blocks;
}

/** Ephemeral sign-in card for a user who hasn't linked a Latch account. */
export function signInCard(linkUrl: string, message?: string): unknown[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: message ?? "Sign in to Latch to use this agent — takes a few seconds.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "latch_link_noop", // link button: handled by url, no callback
          style: "primary",
          text: { type: "plain_text", text: "Sign in to Latch" },
          url: linkUrl,
        },
      ],
    },
  ];
}

/**
 * Error surface for a failed run. A plain section, deliberately: the 2026
 * `alert` block would be nicer but its exact JSON shape isn't verifiable
 * without a live workspace — swap in once confirmed in the dev workspace.
 */
export function errorBlocks(message: string): unknown[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:warning: ${message.slice(0, SECTION_LIMIT - 20)}` },
    },
  ];
}

export const FEEDBACK_ACTION = "latch_feedback";

/** Native 👍/👎 feedback row (`context_actions` + `feedback_buttons`). */
export function feedbackActions(): unknown {
  return {
    type: "context_actions",
    elements: [
      {
        type: "feedback_buttons",
        action_id: FEEDBACK_ACTION,
        positive_button: {
          text: { type: "plain_text", text: "Good response" },
          accessibility_label: "Mark this response as good",
          value: "positive",
        },
        negative_button: {
          text: { type: "plain_text", text: "Bad response" },
          accessibility_label: "Mark this response as bad",
          value: "negative",
        },
      },
    ],
  };
}

