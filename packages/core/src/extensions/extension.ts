/**
 * extension.ts — the extension model.
 *
 * An extension attaches handlers to MOMENTS of a turn. A handler returns an
 * EFFECT, never a rewritten world; `undefined` means no effect. The effect type
 * for each moment says exactly what is possible there, so you cannot do
 * everything everywhere, and several extensions on one moment compose by a
 * rule declared once per moment (see `compose.ts`).
 *
 * WHAT PERSISTS. The stored `UIMessage[]` is the only durable thing; everything
 * else is recomputed each step. Three moments change it:
 *
 *   before_agent_start   injects or replaces messages
 *   step_end             appends parts (append-only; never rewrites)
 *   tool_result          the override IS the stored result, and what the model reads
 *
 * The rest are lenses and vanish after the step:
 *
 *   instructions, context   what the MODEL sees
 *   render                  what the CUSTOMER sees, live AND on load
 *
 * So: mask a secret in `tool_result` and it is gone everywhere (usually right).
 * Use `render` only for the rarer case where the model should keep the truth
 * and the person should not see it.
 *
 * Ported from `experiment/agents-sdk`, where the same model ran 118/119 of its
 * suite over a plain `streamText` loop — the moments do not depend on who owns
 * the loop, which is why they can sit over `ToolLoopAgent` here.
 */

import type {
  Instructions,
  LanguageModel,
  ModelMessage,
  ToolSet,
  UIMessage,
  UIMessagePart,
} from "ai";

/**
 * Who a run is for, as an extension sees it. EMPTY on purpose, and augmented by
 * the application:
 *
 *   declare module "@intentface/latch-core" {
 *     interface Principal { orgId: string; userId: string }
 *   }
 *
 * Augmentation rather than a `<P>` type parameter, because a parameter has to
 * be repeated at every declaration that touches it — the runtime's own `<P>`
 * already rides on twenty-odd exported symbols, and every moment type would
 * inherit the noise. One `declare module` gives the same type safety with no
 * generics in any handler signature. The trade is one principal shape per
 * process, which is what an application has anyway. The runtime hands its `P`
 * through as this type; the two describe the same object.
 *
 * The framework never reads a field of this. Isolation is enforced wherever
 * the principal is USED — the storage owner key, a connection lookup.
 *
 * CONTRACT: principals are persisted with a run and replayed on resume or a
 * scheduled fire, possibly months later. Durable identifiers only: no secrets
 * or tokens, no PII beyond ids, nothing volatile like roles or flags.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Principal {}

/** What is known before the first step: no step number yet, no messages of its own. */
export interface RunContext {
  runId: string;
  principal: Principal;
}

export interface StepContext extends RunContext {
  stepNumber: number;
  /** The stored messages at this step. */
  messages: UIMessage[];
}

/**
 * Token counts for one step. The cache split is carried separately because
 * cached input is billed at a fraction of the normal rate, so a cost extension
 * that only sees `inputTokens` overcharges every cached turn.
 */
export interface StepUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Cached input tokens read. Billed at a discount by most providers. */
  cacheReadTokens?: number;
  /** Input tokens written to the cache. Usually billed at a premium. */
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** What a completed step cost and how it ended. The basis for evals and budgets. */
export interface StepInfo extends StepContext {
  usage: StepUsage;
  finishReason: string;
  model: { provider: string; modelId: string };
  durationMs: number;
  toolCalls: Array<{ toolName: string; toolCallId: string }>;
}

export type Part = UIMessagePart<any, any>;

// --- effects ---------------------------------------------------------------

/**
 * `replace` is how a store says "ignore what the client sent, this is the
 * truth". `inject` adds a message WITHOUT disturbing the response anchor: it
 * lands immediately before the final message, so a synthetic message can never
 * become the assistant message the run streams into. See `compose.messagesIn`.
 */
export type StartEffect = { inject?: UIMessage } | { replace?: UIMessage[] } | undefined | void;

/** Append-only: nothing can rewrite the past. History only grows. */
export type StepEffect = { append?: Part[] } | undefined | void;

/**
 * `append` adds a paragraph of text. `replace` hands over the whole
 * `Instructions` value, which may be a `SystemModelMessage[]` carrying
 * `providerOptions` — that is how prompt-cache breakpoints are set on the
 * system prompt, so this deliberately is NOT narrowed to `string`.
 */
export type InstructionsEffect =
  | { append?: string }
  | { replace?: Instructions }
  | undefined
  | void;

export type ContextEffect = { messages?: ModelMessage[] } | undefined | void;

/** One rule over a part, applied to the live stream AND to stored messages on load. */
export type ViewEffect = { hide?: true } | { replace?: Part } | undefined | void;

export type ToolCallEffect = { block?: true; reason?: string } | undefined | void;

export type ToolResultEffect = { output?: unknown; isError?: boolean } | undefined | void;

/**
 * `transform` rewrites the text before the run starts. `handled` skips the
 * model entirely — `reply` becomes the assistant's answer, so the conversation
 * still reads normally.
 *
 * `replace` exists because a command that answers directly may also need to
 * rewrite what came before (`/compact` is the case); deciding the reply and
 * the rewrite in one place keeps them from disagreeing about whether anything
 * happened.
 */
export type InputEffect =
  | { transform?: string }
  | { handled: true; reply?: string | Part[]; replace?: UIMessage[] }
  | undefined
  | void;

/**
 * Before each model call. `stop` ends the run before this step; `model` and
 * `activeTools` apply to this step only.
 */
export type StepControlEffect =
  | { stop?: true; model?: LanguageModel; activeTools?: string[] }
  | undefined
  | void;

/**
 * EVERY moment receives identity. That is the point of carrying the principal
 * on the turn rather than letting each extension close over one: a per-tenant
 * toolset, a per-tenant veto, a per-tenant redaction rule and per-tenant error
 * reporting all read the SAME principal, so two extensions cannot disagree
 * about who a run is for.
 *
 * It arrives as a trailing `run` argument, which existing handlers may ignore:
 * a function with fewer parameters stays assignable.
 */
export interface Hooks {
  /** User text arrived, before anything runs. Earliest per-message moment. */
  input?: Array<
    (
      info: {
        text: string;
        source: "user" | "extension";
        messages: UIMessage[];
      },
      run: RunContext,
    ) => InputEffect | Promise<InputEffect>
  >;
  /** First run of a conversation (no assistant message yet). Before before_agent_start. */
  session_start?: Array<(messages: UIMessage[], run: RunContext) => StartEffect | Promise<StartEffect>>;
  /**
   * Every run, before the first step. Receives identity as well as messages: a
   * store has to know who a chat belongs to at CLAIM time, not at the first
   * step, or a scheduled run has nothing to rebuild the principal from.
   */
  before_agent_start?: Array<(messages: UIMessage[], run: RunContext) => StartEffect | Promise<StartEffect>>;
  step_end?: Array<(messages: UIMessage[], info: StepInfo) => StepEffect | Promise<StepEffect>>;
  instructions?: Array<
    (
      current: Instructions | undefined,
      ctx: StepContext,
    ) => InstructionsEffect | Promise<InstructionsEffect>
  >;
  context?: Array<(messages: ModelMessage[], ctx: StepContext) => ContextEffect | Promise<ContextEffect>>;
  /**
   * Identity is OPTIONAL here alone, because `renderTranscript` runs on a load
   * route where no run exists. Pass it when the caller knows it, which an
   * authenticated route does.
   */
  render?: Array<(part: Part, ctx: { stored: boolean } & Partial<RunContext>) => ViewEffect>;
  register_tools?: Array<(tools: ToolSet, run: RunContext) => ToolSet>;
  tool_call?: Array<
    (
      info: {
        toolName: string;
        toolCallId: string;
        input: unknown;
      },
      run: RunContext,
    ) => ToolCallEffect | Promise<ToolCallEffect>
  >;
  tool_result?: Array<
    (
      info: {
        toolName: string;
        toolCallId: string;
        input: unknown;
        output: unknown;
        isError: boolean;
        source: "server" | "client";
      },
      run: RunContext,
    ) => ToolResultEffect | Promise<ToolResultEffect>
  >;
  step_start?: Array<(ctx: StepContext) => StepControlEffect | Promise<StepControlEffect>>;
  /** The run failed. Fires before agent_end, which still fires. */
  error?: Array<
    (
      info: { error: unknown; stepNumber: number; messages: UIMessage[] },
      run: RunContext,
    ) => void | Promise<void>
  >;
  agent_end?: Array<
    (info: {
      runId: string;
      principal: Principal;
      messages: UIMessage[];
      stepCount: number;
      isAborted: boolean;
      error?: unknown;
      usage: StepUsage;
    }) => void | Promise<void>
  >;
}

export type Moment = keyof Hooks;

/** What a command answers with: text, parts, or parts plus a rewritten history. */
export type CommandReply =
  | string
  | Part[]
  | { reply?: string | Part[]; replace?: UIMessage[] };

export interface CommandOptions {
  description: string;
  /**
   * Answer directly, no model call.
   *
   * `ctx.messages` is the FULL stored conversation, because commands run after
   * the start moments — a client that posts only its newest turn does not
   * shrink what a command can see.
   */
  handler?: (args: string, ctx: { messages: UIMessage[] }) => CommandReply | Promise<CommandReply>;
  /** Or rewrite the user's text and let the run proceed. */
  expand?: (args: string) => string | Promise<string>;
}

export interface RegisteredCommand extends CommandOptions {
  name: string;
  extension: string;
}

export interface Extension {
  name: string;
  hooks: Hooks;
  commands: RegisteredCommand[];
  /**
   * Fail CLOSED. A throwing handler on a critical extension fails the run
   * instead of being reported and skipped.
   *
   * Default is false, because one broken feature must never break the loop.
   * But that rule is wrong for anything the run's correctness depends on: a
   * persistence extension whose database is down has NOT "produced no effect",
   * it has lost the step. Mark those critical.
   */
  critical?: boolean;
}

/** What the client needs to render a command palette. */
export const listCommands = (
  extensions: Extension[],
): Array<{ name: string; description: string; extension: string }> =>
  extensions.flatMap((e) =>
    e.commands.map((c) => ({ name: c.name, description: c.description, extension: c.extension })),
  );

// --- authoring API ---------------------------------------------------------

export interface ContextOptions {
  /** 'step' every call · 'run' once per request (default) · 'session' once per conversation, stored */
  scope?: "step" | "run" | "session";
  /** 'before-user' (default) prepends to the latest user message · 'system' appends to instructions */
  position?: "before-user" | "system";
}

type Handler<K extends Moment> = NonNullable<Hooks[K]>[number];

export interface ExtensionAPI {
  /** Attach a handler to a moment. Several handlers on one moment run in order. */
  on<K extends Moment>(moment: K, handler: Handler<K>): void;
  /** Add a tool the model can call. */
  registerTool(name: string, definition: ToolSet[string]): void;
  /**
   * A slash command. Sugar over `on('input', …)`: matches `/name …` and passes
   * the rest as args. Return text from `handler` to answer without calling the
   * model, or a string from `expand` to rewrite the prompt and let it run.
   */
  registerCommand(name: string, options: CommandOptions): void;
  /**
   * Change what the CUSTOMER sees, live and on load, without touching storage
   * or the model's view. To hide a value from everyone, use `tool_result`.
   */
  registerRenderer(fn: Handler<"render">): void;
  /**
   * Intent: give the model information. Assembles the moments for you. The
   * provider sees the transcript and the run — `run.principal` is how a
   * per-tenant context is derived.
   */
  context(
    provider: (ctx: { messages: UIMessage[]; run: RunContext }) => string | undefined | Promise<string | undefined>,
    options?: ContextOptions,
  ): void;
  /** Intent: tell the customer something. The model never sees it. */
  notify(provider: (info: StepInfo) => string | undefined | Promise<string | undefined>): void;
}

/** A conversation has not started while nothing has been said back. */
export const isNewSession = (messages: UIMessage[]) => !messages.some((m) => m.role === "assistant");

export interface DefineExtensionOptions {
  /** See `Extension.critical`. */
  critical?: boolean;
}

export function defineExtension(
  name: string,
  setup: (ext: ExtensionAPI) => void,
  options?: DefineExtensionOptions,
): Extension;
export function defineExtension(
  name: string,
  setup: (ext: ExtensionAPI) => Promise<void>,
  options?: DefineExtensionOptions,
): Promise<Extension>;
export function defineExtension(
  name: string,
  setup: (ext: ExtensionAPI) => void | Promise<void>,
  options: DefineExtensionOptions = {},
): Extension | Promise<Extension> {
  const hooks: Hooks = {};
  const on = <K extends Moment>(k: K, fn: Handler<K>) => {
    (hooks[k] ??= [] as never as NonNullable<Hooks[K]>).push(fn as never);
  };
  const registered: Record<string, ToolSet[string]> = {};
  const commands: RegisteredCommand[] = [];

  const api: ExtensionAPI = {
    on,
    registerTool: (n, d) => {
      registered[n] = d;
    },
    registerCommand: (cmdName, opts) => {
      // Caught here, at registration, rather than as a throw the moment a user
      // types the command — which a non-critical extension would swallow,
      // sending the raw `/name` to the model as if nothing had matched.
      if (!opts.handler && !opts.expand)
        throw new Error(`Command "/${cmdName}" on extension "${name}" needs a handler or an expand.`);
      commands.push({ ...opts, name: cmdName, extension: name });
      on("input", async ({ text, messages }) => {
        if (text !== `/${cmdName}` && !text.startsWith(`/${cmdName} `)) return;
        const args = text.slice(cmdName.length + 1).trim();
        if (opts.expand) return { transform: await opts.expand(args) };
        const answer = await opts.handler!(args, { messages });
        if (typeof answer === "string" || Array.isArray(answer))
          return { handled: true, reply: answer };
        return { handled: true, reply: answer.reply, replace: answer.replace };
      });
    },
    registerRenderer: (fn) => on("render", fn),

    context(provider, { scope = "run", position = "before-user" } = {}) {
      const type = `data-ctx-${name}` as const;
      const place = (m: ModelMessage[], text: string): ContextEffect => {
        const i = m.map((x) => x.role).lastIndexOf("user");
        if (i < 0) return;
        const u = m[i]!;
        const content =
          typeof u.content === "string" ? [{ type: "text" as const, text: u.content }] : u.content;
        return {
          messages: [
            ...m.slice(0, i),
            { ...u, content: [{ type: "text" as const, text }, ...content] } as ModelMessage,
            ...m.slice(i + 1),
          ],
        };
      };
      const find = (msgs: UIMessage[]) => {
        for (const m of msgs) for (const p of m.parts) if (p.type === type) return String((p as { data: unknown }).data);
        return undefined;
      };

      if (scope === "session") {
        on("before_agent_start", async (msgs, run) => {
          if (find(msgs)) return;
          const text = await provider({ messages: msgs, run });
          if (text == null) return;
          // Injected BEFORE the final message by `compose.messagesIn`, so this
          // never becomes the assistant message the run streams into.
          return {
            inject: {
              id: crypto.randomUUID(),
              role: "assistant",
              parts: [{ type, data: text } as Part],
            } as UIMessage,
          };
        });
        on("render", (p) => (p.type === type ? { hide: true } : undefined));
        if (position === "system")
          on("instructions", (_, ctx) => {
            const t = find(ctx.messages);
            return t ? { append: t } : undefined;
          });
        else
          on("context", (m, ctx) => {
            const t = find(ctx.messages);
            return t ? place(m, t) : undefined;
          });
        return;
      }

      // One extension object serves every turn of a runtime, concurrently. A
      // run-scoped value is therefore keyed by run id — a single variable would
      // let an overlapping turn's context reach the wrong model call. Populated
      // at the start moment when there is one; a continuation (resume, decision)
      // skips those and fills its entry on first use. Released at the end.
      const perRun = new Map<string, Promise<string | undefined>>();
      const valueFor = (msgs: UIMessage[], run: RunContext) => {
        let p = perRun.get(run.runId);
        if (!p) {
          p = Promise.resolve(provider({ messages: msgs, run }));
          perRun.set(run.runId, p);
        }
        return p;
      };
      if (scope === "run") {
        on("before_agent_start", (msgs, run) => {
          perRun.set(run.runId, Promise.resolve(provider({ messages: msgs, run })));
        });
        on("agent_end", ({ runId }) => {
          perRun.delete(runId);
        });
      }
      const get = (msgs: UIMessage[], run: RunContext) =>
        scope === "run" ? valueFor(msgs, run) : provider({ messages: msgs, run });
      if (position === "system")
        on("instructions", async (_, ctx) => {
          const t = await get(ctx.messages, ctx);
          return t ? { append: t } : undefined;
        });
      else
        on("context", async (m, ctx) => {
          const t = await get(ctx.messages, ctx);
          return t ? place(m, t) : undefined;
        });
    },

    notify(provider) {
      const type = `data-notice-${name}` as const;
      on("step_end", async (_msgs, info) => {
        const text = await provider(info);
        return text == null ? undefined : { append: [{ type, data: text } as Part] };
      });
    },
  };

  const finish = (): Extension => {
    if (Object.keys(registered).length)
      on("register_tools", (t) => ({ ...t, ...registered }));
    return { name, hooks, commands, critical: options.critical ?? false };
  };

  // An async factory is awaited once, before anything runs — the pattern for
  // one-time startup work (load config, open a client, discover models).
  const result = setup(api);
  return result instanceof Promise ? result.then(finish) : finish();
}
