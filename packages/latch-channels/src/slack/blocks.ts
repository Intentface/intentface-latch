/**
 * Hand-rolled Slack Block Kit builders for the small surface a Latch channel
 * needs: an answer message, an approval prompt with Approve/Deny buttons, and an
 * OAuth sign-in link. (eve hand-rolls its HITL blocks too; for this scope it's
 * simpler and keeps the package dependency-free — no Chat SDK runtime.)
 */

const SECTION_LIMIT = 2900; // Slack section text hard limit is 3000.

/** Best-effort GFM → Slack mrkdwn (bold, strike, links). Code fences pass through. */
export function toMrkdwn(gfm: string): string {
  return gfm
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*")
    .replace(/~~(.+?)~~/g, "~$1~")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "<$2|$1>");
}

/** Split long text into section blocks under Slack's per-section limit. */
export function textBlocks(text: string): unknown[] {
  const md = toMrkdwn(text);
  const blocks: unknown[] = [];
  for (let i = 0; i < md.length; i += SECTION_LIMIT) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: md.slice(i, i + SECTION_LIMIT) || " " },
    });
  }
  return blocks.length ? blocks : [{ type: "section", text: { type: "mrkdwn", text: " " } }];
}

// ── Approval round-trip encoding ────────────────────────────────────────────
// The button carries everything needed to resume: action_id says approve/deny,
// the value JSON carries {chatId, agent, approvalId}.

export const APPROVE_ACTION = "latch_approve";
export const DENY_ACTION = "latch_deny";

export interface ApprovalRef {
  chatId: string;
  agent: string;
  approvalId: string;
  /** Carried in the button value so the settled card can name the tool. */
  toolName?: string;
}

function truncateJson(value: unknown, max = 2500): string {
  let s: string;
  try {
    s = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    s = String(value);
  }
  return s.length > max ? `${s.slice(0, max)}\n… (truncated)` : s;
}

/** An approval prompt: the tool + its proposed input, with Approve / Deny. */
export function approvalBlocks(ref: ApprovalRef, toolName: string, input: unknown): unknown[] {
  const value = JSON.stringify({ ...ref, toolName });
  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:lock: Approve *${toolName}*?` },
    },
  ];
  // Some approvals carry no separate input (e.g. a subagent approval whose
  // summary already names the action) — omit the code block rather than
  // rendering a literal "undefined".
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
        value,
      },
      {
        type: "button",
        action_id: DENY_ACTION,
        style: "danger",
        text: { type: "plain_text", text: "Deny" },
        value,
      },
    ],
  });
  return blocks;
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

// ═══════════════════════════════════════════════════════════════════════════
// v2 builders — the `markdown` block (native GFM rendering) replaces the regex
// mrkdwn conversion above; approval cards carry SIGNED payloads (payloads.ts)
// instead of raw JSON. The v1 builders above die with the v1 channel.
// ═══════════════════════════════════════════════════════════════════════════

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

/** Decode an approval button click back into a decision, or null if not ours. */
export function decodeApprovalAction(
  actionId: string,
  value: string | undefined,
): { ref: ApprovalRef; approved: boolean } | null {
  if (actionId !== APPROVE_ACTION && actionId !== DENY_ACTION) return null;
  if (!value) return null;
  try {
    const ref = JSON.parse(value) as ApprovalRef;
    if (!ref?.chatId || !ref?.agent || !ref?.approvalId) return null;
    return { ref, approved: actionId === APPROVE_ACTION };
  } catch {
    return null;
  }
}
