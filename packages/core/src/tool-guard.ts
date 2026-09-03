/**
 * Tool guards — deterministic, code-level policy over every tool call.
 *
 * The HITL approval policy answers "may this happen, human?"; a guard answers
 * "can this ever happen here?" — e.g. a Slack-triggered turn may never read or
 * post outside the channel it was mentioned in. Guards run BEFORE approval:
 * a denied call is never executed and never shown to a human, and the reason
 * goes back to the model as a tool result so the turn continues.
 *
 * Mechanism: the runtime installs `guardedApprovalPolicy` as the AI SDK's
 * generic `toolApproval` function. The SDK calls it once per tool call; on a
 * guard denial it returns the SDK's `denied` status (the SDK then emits a
 * `tool-result` with the reason and skips `execute`); on allow it applies the
 * policy the runtime would otherwise have passed — the merged per-tool
 * statuses (or per-tool functions), the agent's own function policy, or, for
 * tools neither names, the tool's own `needsApproval`. This works for tools
 * without `execute` (client-side / provider-executed), and the SDK re-runs the
 * policy on resume, so a guard can retro-deny a stale approval.
 *
 * Scope (v1): runtime-level guards only (`RuntimeConfig.toolGuards`). Agent- and
 * tool-source-level guards are a later extension of the same call shape.
 */
import type { TurnTrigger } from "./runtime.js";

export interface ToolGuardCall<P> {
  /** Tool name as the model called it. */
  tool: string;
  /** Validated tool input. */
  input: unknown;
  toolCallId: string;
  principal: P;
  /** The chat this turn runs in (a subagent's own `sub_…` chat for delegated turns). */
  chatId: string;
  /** The originating chat of the whole delegation tree — scope by THIS. */
  rootChatId: string;
  /** The run this call belongs to (joins audit rows to runs / traces). */
  runId: string;
  agent: string;
  trigger: TurnTrigger;
}

export type ToolGuardDecision = { allow: true } | { allow: false; reason: string };

export type ToolGuard<P> = (
  call: ToolGuardCall<P>,
) => ToolGuardDecision | Promise<ToolGuardDecision>;

/** Per-turn fields shared by every call the policy evaluates. */
export type ToolGuardTurnContext<P> = Omit<ToolGuardCall<P>, "tool" | "input" | "toolCallId">;

/** AND-compose: guards run in order, the first denial wins. */
export async function evaluateGuards<P>(
  guards: readonly ToolGuard<P>[],
  call: ToolGuardCall<P>,
): Promise<ToolGuardDecision> {
  for (const guard of guards) {
    const decision = await guard(call);
    if (!decision.allow) return decision;
  }
  return { allow: true };
}

/**
 * The SDK's generic approval-function options (the slice we read/forward).
 * `tools`/`toolsContext`/`runtimeContext`/`messages` are passed through to
 * per-tool policies and `needsApproval`, mirroring what the SDK itself does
 * when no generic function is installed.
 */
export interface ApprovalCallOptions {
  toolCall: { toolName: string; input: unknown; toolCallId: string };
  tools?: Record<string, unknown>;
  toolsContext?: Record<string, unknown>;
  runtimeContext?: unknown;
  messages?: unknown[];
}

/** What a per-tool policy / `needsApproval` function receives. */
const perToolOptions = (o: ApprovalCallOptions) => ({
  toolCallId: o.toolCall.toolCallId,
  messages: o.messages ?? [],
  toolContext: o.toolsContext?.[o.toolCall.toolName],
  runtimeContext: o.runtimeContext,
});

/**
 * Build the SDK `toolApproval` for a turn: guards first, then `base`.
 *
 * `base` is whatever the runtime would have passed without guards: the merged
 * object policy (tool name → status or per-tool function), the agent's own
 * generic function policy, or `undefined` (autonomous / subagent turns, which
 * waive approvals but must still be guarded). Tools the object policy does not
 * name fall back to their own `needsApproval` — the SDK only consults that when
 * no generic function is installed, so we re-create it here.
 */
export function guardedApprovalPolicy<P>(
  guards: readonly ToolGuard<P>[],
  base: unknown,
  ctx: ToolGuardTurnContext<P>,
): (options: ApprovalCallOptions) => Promise<unknown> {
  const baseObject =
    base && typeof base === "object" ? (base as Record<string, unknown>) : undefined;
  const baseFn = typeof base === "function" ? (base as (o: unknown) => unknown) : undefined;
  return async (options) => {
    const { toolCall } = options;
    const decision = await evaluateGuards(guards, {
      ...ctx,
      tool: toolCall.toolName,
      input: toolCall.input,
      toolCallId: toolCall.toolCallId,
    });
    if (!decision.allow) return { type: "denied", reason: decision.reason };
    if (baseFn) return baseFn(options);
    const entry = baseObject?.[toolCall.toolName];
    if (typeof entry === "function") {
      return (entry as (input: unknown, o: unknown) => unknown)(
        toolCall.input,
        perToolOptions(options),
      );
    }
    if (entry !== undefined) return entry;
    // Neither the merged policy nor the agent named this tool: honor the tool's
    // own `needsApproval` (boolean or function), as the SDK would.
    const tool = options.tools?.[toolCall.toolName] as
      | { needsApproval?: boolean | ((input: unknown, o: unknown) => unknown) }
      | undefined;
    const needs = tool?.needsApproval;
    if (typeof needs === "function") {
      return (await needs(toolCall.input, perToolOptions(options)))
        ? "user-approval"
        : "not-applicable";
    }
    return needs ? "user-approval" : "not-applicable";
  };
}
