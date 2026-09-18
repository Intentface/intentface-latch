/**
 * tools.ts — the tool-side wiring: `tool_call` vetoes and `tool_result`
 * rewrites over a toolset, plus the small transcript helpers the runtime uses
 * to apply start-moment and step-end effects.
 */
import type { ToolSet, UIMessage } from "ai";
import type { Composed } from "./compose.js";
import type { Part, RunContext } from "./extension.js";

/** Prototype-safe lookup: a tool named `__proto__` must not resolve to Object.prototype. */
const getOwn = <T>(o: Record<string, T>, k: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;

/** What a blocked tool call returns to the model. A result, not a throw, so the reason survives. */
export interface BlockedToolOutput {
  blocked: true;
  reason: string;
}

/**
 * Wrap every executable tool so `tool_call` can veto and `tool_result` can
 * rewrite what gets stored. With no listener on either moment the toolset is
 * returned untouched — the identity of every tool object is preserved.
 *
 * The AI SDK's `executeTool` sniffs synchronously for `Symbol.asyncIterator`,
 * so a wrapper that returns a promise turns a streaming tool into a
 * non-streaming one: no progress chunks, and a generator object as the output.
 * Two paths follow from that, chosen once per run:
 *
 *   no `tool_call` listener   call `execute` synchronously, pass the iterable
 *                             through, hold one value back so the FINAL yield
 *                             is the hooked one. Streaming preserved.
 *   a `tool_call` listener    the veto is async and must resolve before
 *                             `execute` runs, so the result is a promise and
 *                             progress chunks are collapsed. A gated tool
 *                             cannot also stream; that is the trade.
 */
export function wrapTools(tools: ToolSet, hooks: Composed, run: RunContext): ToolSet {
  const gating = hooks.has("tool_call");
  const hooked = gating || hooks.has("tool_result");
  if (!hooked) return tools;

  const out: Record<string, unknown> = {};
  for (const [toolName, t] of Object.entries(tools)) {
    const execute = (t as { execute?: (...a: unknown[]) => unknown }).execute;
    if (typeof execute !== "function") {
      out[toolName] = t;
      continue;
    }
    /**
     * Run `tool_result` over an outcome and return what the SDK should see.
     * An `isError` override flips the outcome: a failure a handler marks
     * `isError: false` is returned as a result, a result it marks `isError:
     * true` is thrown so the SDK records a tool error — the model then sees
     * whatever `output` the handler left, as it would any thrown value.
     */
    const settle = async (input: unknown, toolCallId: string, output: unknown, isError: boolean) => {
      const e = await hooks.toolResult({ toolName, toolCallId, input, output, isError, source: "server" }, run);
      const finalOutput = e && e.output !== undefined ? e.output : output;
      const finalIsError = e?.isError ?? isError;
      if (finalIsError) throw finalOutput;
      return finalOutput;
    };
    const attempt = <T,>(fn: () => Promise<T>): Promise<T> => fn();

    out[toolName] = {
      ...t,
      execute(input: unknown, o: { toolCallId: string }) {
        if (gating) {
          return (async () => {
            const blocked = await hooks.toolCall({ toolName, toolCallId: o.toolCallId, input }, run);
            if (blocked && "block" in blocked && blocked.block) {
              const denial: BlockedToolOutput = {
                blocked: true,
                reason: blocked.reason ?? `The ${toolName} call was not allowed.`,
              };
              return settle(input, o.toolCallId, denial, false);
            }
            try {
              const r = execute.call(t, input, o);
              if (r != null && typeof (r as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
                let held: { v: unknown } | undefined;
                for await (const v of r as AsyncIterable<unknown>) held = { v };
                return await settle(input, o.toolCallId, held?.v, false);
              }
              return await settle(input, o.toolCallId, await r, false);
            } catch (error) {
              // A rejected execute is a tool result too — the failed kind. Let
              // the hook see it; it may rescue it or rewrite the error.
              return settle(input, o.toolCallId, error, true);
            }
          })();
        }

        // Streaming-safe path: no await before `execute`, no await before the sniff.
        let result: unknown;
        try {
          result = execute.call(t, input, o);
        } catch (error) {
          return settle(input, o.toolCallId, error, true);
        }
        if (result != null && typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
          return (async function* () {
            let held: { v: unknown } | undefined;
            try {
              for await (const v of result as AsyncIterable<unknown>) {
                if (held) yield held.v;
                held = { v };
              }
            } catch (error) {
              yield await settle(input, o.toolCallId, error, true);
              return;
            }
            if (held) yield await settle(input, o.toolCallId, held.v, false);
          })();
        }
        return attempt(() => Promise.resolve(result)).then(
          (v) => settle(input, o.toolCallId, v, false),
          (error) => settle(input, o.toolCallId, error, true),
        );
      },
    };
  }
  return out as ToolSet;
}

/**
 * Fire `tool_result` for outputs a CLIENT produced.
 *
 * A client tool has no server `execute`, so the wrapper above never sees it:
 * its output arrives in a later request, already in the transcript. Without
 * this, an extension that inspects or redacts tool results silently covers
 * server tools only, while the type promises both.
 *
 * Only parts after the last `step-start` are considered — the same slice the
 * SDK's own auto-resubmit uses — so outputs an earlier run already handled are
 * not fired again.
 */
export async function fireClientToolResults(
  messages: UIMessage[],
  tools: ToolSet,
  hooks: Composed,
  run: RunContext,
): Promise<UIMessage[]> {
  const i = messages.length - 1;
  const last = messages[i];
  if (!last || last.role !== "assistant") return messages;

  type P = {
    type: string;
    toolName?: string;
    toolCallId?: string;
    state?: string;
    input?: unknown;
    output?: unknown;
  };
  const parts = last.parts as P[];
  let from = 0;
  for (let k = parts.length - 1; k >= 0; k--)
    if (parts[k]!.type === "step-start") {
      from = k;
      break;
    }

  const next = [...parts];
  let changed = false;
  for (let k = from; k < parts.length; k++) {
    const p = parts[k]!;
    const isTool = p.type.startsWith("tool-") || p.type === "dynamic-tool";
    if (!isTool || !p.toolCallId) continue;
    if (p.state !== "output-available" && p.state !== "output-error") continue;

    const name = p.type === "dynamic-tool" ? (p.toolName ?? "") : p.type.slice("tool-".length);
    const t = getOwn(tools as Record<string, unknown>, name) as { execute?: unknown } | undefined;
    if (typeof t?.execute === "function") continue; // a server tool; already hooked

    const e = await hooks.toolResult({
      toolName: name,
      toolCallId: p.toolCallId,
      input: p.input,
      output: p.output,
      isError: p.state === "output-error",
      source: "client",
    }, run);
    if (e && e.output !== undefined) {
      next[k] = { ...p, output: e.output } as P;
      changed = true;
    }
  }
  return changed ? [...messages.slice(0, i), { ...last, parts: next } as UIMessage] : messages;
}

/** Append parts onto the run's assistant message (or start one). */
export function appendParts(messages: UIMessage[], parts: Part[]): UIMessage[] {
  if (!parts.length) return messages;
  const i = messages.length - 1;
  const last = messages[i];
  if (!last || last.role !== "assistant")
    return [...messages, { id: crypto.randomUUID(), role: "assistant", parts } as UIMessage];
  return [...messages.slice(0, i), { ...last, parts: [...(last.parts as Part[]), ...parts] } as UIMessage];
}

/**
 * Fold `step_end` parts into an assistant message the SDK assembled without
 * them: each step's appended parts go before the NEXT `step-start`, the last
 * step's at the end — exactly where an append at that step boundary would have
 * landed. `priorSteps` skips step-start parts the message already carried
 * before this run (a continuation reuses the assistant message).
 */
export function insertStepParts(
  message: UIMessage,
  appendedByStep: Map<number, Part[]>,
  priorSteps = 0,
): UIMessage {
  if (!appendedByStep.size) return message;
  const out: Part[] = [];
  let seen = 0;
  let step = -1;
  for (const p of message.parts as Part[]) {
    if (p.type === "step-start") {
      seen++;
      if (seen > priorSteps) {
        if (step >= 0) out.push(...(appendedByStep.get(step) ?? []));
        step++;
      }
    }
    out.push(p);
  }
  if (step >= 0) out.push(...(appendedByStep.get(step) ?? []));
  return { ...message, parts: out } as UIMessage;
}

/** The text of the newest user message, if any. */
export const lastUserTextOf = (messages: UIMessage[]): string | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const t = (m.parts as Part[]).find((p) => p.type === "text") as { text?: string } | undefined;
    return t?.text;
  }
  return undefined;
};

/** Rewrite the first text part of the newest user message (an `input` transform). */
export const replaceLastUserText = (messages: UIMessage[], text: string): UIMessage[] => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    let done = false;
    const parts = (m.parts as Part[]).map((p) => {
      if (done || p.type !== "text") return p;
      done = true;
      return { ...p, text } as Part;
    });
    return [...messages.slice(0, i), { ...m, parts } as UIMessage, ...messages.slice(i + 1)];
  }
  return messages;
};
