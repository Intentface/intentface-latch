/**
 * Audit events the Slack channel emits — one per admission decision (did we
 * act on this message / click?) and, via `slackScopeGuard`, one per tool call
 * a Slack-triggered turn makes. Hosts persist them; the adapter never blocks
 * on the write.
 */
export type SlackAuditAction =
  /** A message started a new chat. */
  | "trigger"
  /** A message continued an existing chat. */
  | "resume"
  /** An approval button was clicked. */
  | "approval_click"
  /** A tool call inside a Slack-triggered turn (from the scope guard). */
  | "tool_call";

export interface SlackAuditEvent {
  action: SlackAuditAction;
  decision: "allow" | "deny";
  /** Machine-readable reason for a deny (e.g. `external_workspace`, `non_starter`). */
  reason?: string;
  appId?: string;
  teamId?: string;
  channelId?: string;
  threadRoot?: string;
  slackUserId?: string;
  chatId?: string;
  /** The run a `tool_call` belongs to. */
  runId?: string;
  /** Small, JSON-serialisable extras (tool name, offending channel, …). */
  meta?: Record<string, unknown>;
}

export type SlackAuditSink = (event: SlackAuditEvent) => void | Promise<void>;
