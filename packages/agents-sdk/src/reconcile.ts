/**
 * reconcile.ts — merging what a client sends with what a store holds.
 *
 * Any persistence extension faces the same problem. "The store is the truth"
 * is right for history and wrong for exactly two things, because the client is
 * their only source:
 *
 *   approval decisions      approved / denied, with a reason
 *   client tool outputs     a tool with no server `execute`
 *
 * Both arrive as an UPDATE to a message the store already has — the trailing
 * assistant message the run ended on — not as a new message. So a merge that
 * dedupes by message id silently discards them, the tool calls stay
 * unanswered, and the next run dies with "Tool results are missing for tool
 * calls …" from `convertToModelMessages`.
 *
 * The merge is deliberately narrow. Only the resolution fields of tool parts
 * are taken from the client, matched by `toolCallId`, and only where the store
 * has no answer yet. Text, reasoning, and anything already resolved stay as
 * the store has them, so a client cannot rewrite what the assistant said or
 * flip a decision that was already recorded.
 */
import type { UIMessage } from "ai";

type AnyPart = {
  type: string;
  toolCallId?: string;
  state?: string;
  output?: unknown;
  errorText?: string;
  approval?: { id?: string; approved?: boolean; reason?: string };
};

const isTool = (p: AnyPart) => p.type.startsWith("tool-") || p.type === "dynamic-tool";

/** A part the store still considers open: asked for, not yet answered. */
const unresolved = (p: AnyPart) =>
  p.state === "approval-requested" || p.state === "input-available";

/** A part the client has now answered, either by deciding or by running it. */
const resolved = (p: AnyPart) =>
  p.state === "approval-responded" ||
  p.state === "output-available" ||
  p.state === "output-error" ||
  p.state === "output-denied";

function mergeParts(stored: AnyPart[], incoming: AnyPart[]): AnyPart[] {
  const answers = new Map<string, AnyPart>();
  for (const p of incoming) if (isTool(p) && p.toolCallId && resolved(p)) answers.set(p.toolCallId, p);
  if (!answers.size) return stored;

  return stored.map((p) => {
    if (!isTool(p) || !p.toolCallId || !unresolved(p)) return p;
    const a = answers.get(p.toolCallId);
    if (!a) return p;
    // Take only the fields that carry the answer, never the whole part.
    return {
      ...p,
      state: a.state,
      ...(a.approval ? { approval: { ...p.approval, ...a.approval } } : {}),
      ...(a.output !== undefined ? { output: a.output } : {}),
      ...(a.errorText !== undefined ? { errorText: a.errorText } : {}),
    };
  });
}

/**
 * Stored history plus whatever the client legitimately contributes: answers to
 * open tool calls on messages the store already has, and any genuinely new
 * messages, appended in the order they were sent.
 */
export function reconcile(stored: UIMessage[], incoming: UIMessage[]): UIMessage[] {
  if (!stored.length) return incoming;

  const byId = new Map(incoming.map((m) => [m.id, m]));
  const merged = stored.map((m) => {
    const sent = byId.get(m.id);
    if (!sent) return m;
    const parts = mergeParts(m.parts as AnyPart[], sent.parts as AnyPart[]);
    return parts === m.parts ? m : ({ ...m, parts } as UIMessage);
  });

  const known = new Set(stored.map((m) => m.id));
  const fresh = incoming.filter((m) => !known.has(m.id));
  return fresh.length ? [...merged, ...fresh] : merged;
}
