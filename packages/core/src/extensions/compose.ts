/**
 * compose.ts — effect dispatch.
 *
 * Extensions run in array order. Each moment has its own merge rule, chosen so
 * the result is predictable when several extensions answer at once:
 *
 *   append / inject             accumulate — everyone's contribution lands
 *   block / stop                first wins — a veto is a veto
 *   replace / transform         last wins  — later extensions layer on earlier
 *   chained transforms          each sees the previous one's output
 *
 * FAILURE. A throwing handler is caught, reported, and treated as "no effect",
 * so one bad extension cannot break the loop. That rule is deliberately NOT
 * universal: an extension marked `critical` rethrows instead, because a
 * persistence handler whose database is down has not "produced no effect", it
 * has lost the step.
 *
 * ORDER MATTERS for `step_end`: handlers run in extension order and the next
 * model call waits for all of them, so list an extension that persists before
 * the ones that merely observe.
 */
import type { Instructions, LanguageModel, ModelMessage, SystemModelMessage, ToolSet, UIMessage } from "ai";
import type {
  Extension,
  Hooks,
  InputEffect,
  Moment,
  Part,
  Principal,
  RunContext,
  StepContext,
  StepInfo,
  StepUsage,
  ViewEffect,
} from "./extension.js";

export interface ComposeOptions {
  onExtensionError?: (info: { extension: string; moment: string; error: unknown }) => void;
}

/** Thrown when a `critical` extension's handler throws. Fails the run. */
export class ExtensionFailedError extends Error {
  readonly extension: string;
  readonly moment: string;
  readonly cause: unknown;
  constructor(extension: string, moment: string, cause: unknown) {
    super(`[extension:${extension}] ${moment} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ExtensionFailedError";
    this.extension = extension;
    this.moment = moment;
    this.cause = cause;
  }
}

type Named<K extends Moment> = Array<{
  ext: string;
  critical: boolean;
  fn: NonNullable<Hooks[K]>[number];
}>;

/** Instructions + accumulated text appends, preserving any providerOptions on the base. */
export function withAppends(base: Instructions | undefined, appended: string[]): Instructions | undefined {
  if (!appended.length) return base;
  const text = appended.join("\n");
  if (base == null) return text;
  if (typeof base === "string") return [base, text].filter(Boolean).join("\n");
  // A SystemModelMessage (or array of them) may carry providerOptions — e.g. a
  // prompt-cache breakpoint. Never flatten those to a string; add a message.
  const head: SystemModelMessage[] = Array.isArray(base) ? base : [base];
  return [...head, { role: "system", content: text }];
}

export function compose(extensions: Extension[], options: ComposeOptions = {}) {
  const report =
    options.onExtensionError ??
    ((i: { extension: string; moment: string; error: unknown }) =>
      console.error(`[extension:${i.extension}] ${i.moment}`, i.error));

  const handlers = <K extends Moment>(k: K): Named<K> =>
    extensions.flatMap((e) =>
      (e.hooks[k] ?? []).map((fn) => ({
        ext: e.name,
        critical: e.critical === true,
        fn: fn as NonNullable<Hooks[K]>[number],
      })),
    );

  /**
   * Run one handler. A throw becomes `undefined` and is reported — unless the
   * extension is critical, in which case it is wrapped and rethrown.
   */
  const safe = async <T>(
    h: { ext: string; critical: boolean },
    moment: string,
    run: () => T | Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      if (h.critical) throw new ExtensionFailedError(h.ext, moment, error);
      report({ extension: h.ext, moment, error });
      return undefined;
    }
  };

  const safeSync = <T>(h: { ext: string; critical: boolean }, moment: string, run: () => T): T | undefined => {
    try {
      return run();
    } catch (error) {
      if (h.critical) throw new ExtensionFailedError(h.ext, moment, error);
      report({ extension: h.ext, moment, error });
      return undefined;
    }
  };

  return {
    /**
     * Whether any extension listens to a moment. The tool wrapper needs this:
     * a veto is async, and awaiting it before `execute` would defeat the
     * synchronous `Symbol.asyncIterator` sniff that streaming tools rely on.
     * With no `tool_call` listener it can stay on the streaming-safe path.
     */
    has(moment: Moment): boolean {
      return extensions.some((e) => (e.hooks[moment]?.length ?? 0) > 0);
    },

    /** first wins: the first extension to handle or transform decides */
    async input(
      text: string,
      messages: UIMessage[],
      run: RunContext,
      source: "user" | "extension" = "user",
    ): Promise<InputEffect> {
      for (const h of handlers("input")) {
        const e = await safe(h, "input", () => h.fn({ text, source, messages }, run));
        if (e) return e;
      }
      return undefined;
    },

    /**
     * `replace` is last-wins. `inject` accumulates, and lands BEFORE the final
     * message: the last message is the response anchor (`originalMessages` for
     * the UI stream), so appending a synthetic assistant message there would
     * make the model's reply merge into it.
     */
    async messagesIn(
      moment: "session_start" | "before_agent_start",
      messages: UIMessage[],
      run: RunContext,
    ): Promise<UIMessage[]> {
      let out = messages;
      const injected: UIMessage[] = [];
      for (const h of handlers(moment)) {
        const e = await safe(h, moment, () => h.fn(out, run));
        if (!e) continue;
        if ("replace" in e && e.replace) out = e.replace;
        if ("inject" in e && e.inject) injected.push(e.inject);
      }
      if (!injected.length) return out;
      if (!out.length) return injected;
      return [...out.slice(0, -1), ...injected, out[out.length - 1]!];
    },

    /** stop: first wins. model/activeTools: last wins. */
    async stepStart(
      ctx: StepContext,
    ): Promise<{ stop: boolean; model?: LanguageModel; activeTools?: string[] }> {
      let stop = false;
      let model: LanguageModel | undefined;
      let activeTools: string[] | undefined;
      for (const h of handlers("step_start")) {
        const e = await safe(h, "step_start", () => h.fn(ctx));
        if (!e) continue;
        if (e.stop && !stop) stop = true;
        if (e.model) model = e.model;
        if (e.activeTools) activeTools = e.activeTools;
      }
      return { stop, model, activeTools };
    },

    /** append accumulates; a replace resets the accumulation */
    async instructions(
      current: Instructions | undefined,
      ctx: StepContext,
    ): Promise<Instructions | undefined> {
      let base = current;
      const appended: string[] = [];
      for (const h of handlers("instructions")) {
        const e = await safe(h, "instructions", () => h.fn(base, ctx));
        if (!e) continue;
        if ("replace" in e && e.replace != null) {
          base = e.replace;
          appended.length = 0;
        }
        if ("append" in e && e.append) appended.push(e.append);
      }
      return withAppends(base, appended);
    },

    /** chained: each extension sees the previous one's messages */
    async context(messages: ModelMessage[], ctx: StepContext): Promise<ModelMessage[]> {
      let out = messages;
      for (const h of handlers("context")) {
        const e = await safe(h, "context", () => h.fn(out, ctx));
        if (e?.messages) out = e.messages;
      }
      return out;
    },

    tools(tools: ToolSet, run: RunContext): ToolSet {
      let out = tools;
      for (const h of handlers("register_tools")) {
        const r = safeSync(h, "register_tools", () => h.fn(out, run));
        if (r) out = r;
      }
      return out;
    },

    /** hide wins outright; otherwise replacements layer */
    view(part: Part, stored: boolean, run?: RunContext): ViewEffect {
      let current = part;
      let replaced = false;
      for (const h of handlers("render")) {
        const e = safeSync(h, "render", () => h.fn(current, { stored, ...run }));
        if (!e) continue;
        if ("hide" in e && e.hide) return { hide: true };
        if ("replace" in e && e.replace) {
          current = e.replace;
          replaced = true;
        }
      }
      return replaced ? { replace: current } : undefined;
    },

    /** first block wins — a veto is a veto */
    async toolCall(info: { toolName: string; toolCallId: string; input: unknown }, run: RunContext) {
      for (const h of handlers("tool_call")) {
        const e = await safe(h, "tool_call", () => h.fn(info, run));
        if (e && "block" in e && e.block) return e;
      }
      return undefined;
    },

    /** chained: each extension sees the previous one's output */
    async toolResult(info: {
      toolName: string;
      toolCallId: string;
      input: unknown;
      output: unknown;
      isError: boolean;
      source: "server" | "client";
    }, run: RunContext) {
      let { output, isError } = info;
      let changed = false;
      for (const h of handlers("tool_result")) {
        const e = await safe(h, "tool_result", () => h.fn({ ...info, output, isError }, run));
        if (!e) continue;
        if ("output" in e && e.output !== undefined) {
          output = e.output;
          changed = true;
        }
        if (e.isError !== undefined) {
          isError = e.isError;
          changed = true;
        }
      }
      return changed ? { output, isError } : undefined;
    },

    /** all appends accumulate */
    async stepEnd(messages: UIMessage[], info: StepInfo): Promise<Part[]> {
      const appended: Part[] = [];
      for (const h of handlers("step_end")) {
        const e = await safe(h, "step_end", () => h.fn(messages, info));
        if (e?.append) appended.push(...e.append);
      }
      return appended;
    },

    async error(info: { error: unknown; stepNumber: number; messages: UIMessage[] }, run: RunContext) {
      for (const h of handlers("error")) await safe(h, "error", () => h.fn(info, run));
    },

    async agentEnd(info: {
      runId: string;
      principal: Principal;
      messages: UIMessage[];
      stepCount: number;
      isAborted: boolean;
      error?: unknown;
      usage: StepUsage;
    }) {
      for (const h of handlers("agent_end")) await safe(h, "agent_end", () => h.fn(info));
    },
  };
}

export type Composed = ReturnType<typeof compose>;

/**
 * Stored transcript → what the customer may see. Applies every `render` rule to
 * every part; a message left with no parts is dropped. Call this on a load
 * route, after the client projection.
 */
export function renderTranscript(
  extensions: Extension[],
  messages: UIMessage[],
  /** Supply it when the caller knows it — an authenticated load route does. */
  run?: RunContext,
): UIMessage[] {
  const hooks = compose(extensions);
  if (!hooks.has("render")) return messages;
  const out: UIMessage[] = [];
  for (const m of messages) {
    const parts: Part[] = [];
    for (const p of m.parts as Part[]) {
      const e = hooks.view(p, true, run);
      if (e && "hide" in e && e.hide) continue;
      parts.push(e && "replace" in e && e.replace ? e.replace : p);
    }
    if (parts.length) out.push({ ...m, parts } as UIMessage);
  }
  return out;
}
