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
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:lock: Approve *${toolName}*?` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "```" + truncateJson(input) + "```" },
    },
    {
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
    },
  ];
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
