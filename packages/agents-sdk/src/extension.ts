/**
 * extension.ts — the extension model.
 *
 * Handlers return an EFFECT, not a rewritten world. `undefined` means no
 * effect. The effect type for each moment says exactly what is possible there,
 * so you cannot do everything everywhere.
 *
 * WHAT PERSISTS. The stored `UIMessage[]` is the only durable thing;
 * everything else is recomputed each step. Three moments change it:
 *
 *   before_agent_start   injects or replaces messages
 *   step_end             appends parts (append-only; never rewrites)
 *   tool_result          the override IS the stored result, and what the model reads
 *
 * The rest are lenses and vanish after the step:
 *
 *   instructions, context, data_part   what the MODEL sees
 *   render                             what the CUSTOMER sees, live AND on load
 *
 * So: mask a secret in `tool_result` and it is gone everywhere (usually
 * right). Use `render` only for the rarer case where the model should keep the
 * truth and the person should not see it.
 */

import type {
  Instructions,
  LanguageModel,
  ModelMessage,
  ToolSet,
  UIMessage,
  UIMessageChunk,
  UIMessagePart,
} from "ai";

/**
 * Who a run is for. EMPTY on purpose, and augmented by the application:
 *
 *   declare module "@intentface/agents-sdk" {
 *     interface Principal { orgId: string; userId: string }
 *   }
 *
 * Augmentation rather than a `<P>` type parameter, because a parameter has to
 * be repeated at every declaration that touches it. In latch, 23 exported
 * symbols carry one and several carry two, so every helper an application
 * writes inherits the noise. One `declare module` gives the same type safety
 * with no generics in any signature. The trade is one principal shape per
 * process, which is what an application has anyway.
 *
 * The framework never reads a field of this. Isolation is enforced wherever
 * the principal is USED — a storage key, a connection lookup — the same way
 * latch keeps tenancy vocabulary out of the core.
 *
 * CONTRACT: principals are persisted in cleartext with a run and replayed on
 * resume or a scheduled fire, possibly months later. Durable identifiers only:
 * no secrets or tokens, no PII beyond ids, nothing volatile like roles or
 * flags. Derive those per turn instead.
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

/**
 * What to do with one chunk on its way to the client. `null` drops it,
 * an array fans it out, `undefined` leaves it alone.
 *
 * A different axis from `render`, which is why both exist. `render` asks what
 * a PART should look like and applies on load as well as live, so it is the
 * right place for "this value is masked". `chunk` asks what should reach a
 * client at all, live only, so it is the right place for "this client does not
 * want reasoning" — a preference, not a redaction. Storage keeps everything
 * either way.
 */
export type ChunkEffect = UIMessageChunk | UIMessageChunk[] | null | undefined | void;

export type ToolCallEffect = { block?: true; reason?: string } | undefined | void;

export type ToolResultEffect = { output?: unknown; isError?: boolean } | undefined | void;

/**
 * `transform` rewrites the text before the run starts. `handled` skips the
 * model entirely — `reply` becomes the assistant's answer, so the conversation
 * still reads normally.
 *
 * `replace` exists because a command that answers directly may also need to
 * rewrite what came before: `/compact` is the case, and doing it through a flag
 * read by a later moment was worse — the flag and the reply were decided in
 * different places and could disagree about whether anything happened.
 */
export type InputEffect =
  | { transform?: string }
  | { handled: true; reply?: string | Part[]; replace?: UIMessage[] }
  | undefined
  | void;

/**
 * Before each model call. `stop` ends the run after this step; `model` and
 * `activeTools` apply to this step only.
 */
export type StepControlEffect =
  | { stop?: true; model?: LanguageModel; activeTools?: string[] }
  | undefined
  | void;

/**
 * Inject a message while the agent is working. `steer` is applied before the
 * next step; `follow_up` revives a run that was about to finish.
 */
export type SteerEffect = { messages?: UIMessage[] } | undefined | void;

/**
 * EVERY moment receives identity. That is the point of carrying the principal
 * on the loop rather than letting each extension close over one: a per-tenant
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
  data_part?: Array<(part: Part, run: RunContext) => { text?: string } | undefined | void>;
  /**
   * Identity is OPTIONAL here alone, because `renderTranscript` runs on a load
   * route where no run exists. Pass it to `renderTranscript` when the caller
   * knows it, which an authenticated route does.
   */
  render?: Array<(part: Part, ctx: { stored: boolean } & Partial<RunContext>) => ViewEffect>;
  /** Every chunk on its way to the client, live. Never touches storage. */
  chunk?: Array<(chunk: UIMessageChunk, ctx: StepContext) => ChunkEffect>;
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
  /** Between steps: anything queued to steer the agent mid-run. */
  steer?: Array<(ctx: StepContext) => SteerEffect | Promise<SteerEffect>>;
  /** The run is about to end. Return messages to keep it going instead. */
  follow_up?: Array<(ctx: StepContext) => SteerEffect | Promise<SteerEffect>>;
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
      usage: StepInfo["usage"];
    }) => void | Promise<void>
  >;
}

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

type Handler<K extends keyof Hooks> = NonNullable<Hooks[K]>[number];

export interface API {
  /** Attach a handler to a moment. Several handlers on one moment run in order. */
  on<K extends keyof Hooks>(moment: K, handler: Handler<K>): void;
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
  /** Intent: give the model information. Assembles the moments for you. */
  context(
    provider: (ctx: { messages: UIMessage[] }) => string | undefined | Promise<string | undefined>,
    options?: ContextOptions,
  ): void;
  /** Intent: tell the customer something. The model never sees it. */
  notify(provider: (info: StepInfo) => string | undefined | Promise<string | undefined>): void;
}

/**
 * Drop whole families of chunk from what a client receives, keeping them in
 * storage. `"reasoning"` covers `reasoning-start`/`-delta`/`-end`/`-file`,
 * `"tool"` every `tool-*`, and so on by prefix.
 *
 *   extensions: [dropChunks("reasoning", "source")]
 */
export const dropChunks = (...prefixes: string[]): Extension => ({
  name: `drop:${prefixes.join(",")}`,
  commands: [],
  hooks: {
    chunk: [(c) => (prefixes.some((p) => c.type.startsWith(p)) ? null : undefined)],
  },
});

/** A conversation has not started while nothing has been said back. */
export const isNewSession = (messages: UIMessage[]) => !messages.some((m) => m.role === "assistant");

export interface DefineOptions {
  /** See `Extension.critical`. */
  critical?: boolean;
}

export function defineExtension(
  name: string,
  setup: (ext: API) => void,
  options?: DefineOptions,
): Extension;
export function defineExtension(
  name: string,
  setup: (ext: API) => Promise<void>,
  options?: DefineOptions,
): Promise<Extension>;
export function defineExtension(
  name: string,
  setup: (ext: API) => void | Promise<void>,
  options: DefineOptions = {},
): Extension | Promise<Extension> {
  const hooks: Hooks = {};
  const on = <K extends keyof Hooks>(k: K, fn: Handler<K>) => {
    (hooks[k] ??= [] as never as NonNullable<Hooks[K]>).push(fn as never);
  };
  const registered: Record<string, ToolSet[string]> = {};
  const commands: RegisteredCommand[] = [];

  const api: API = {
    on,
    registerTool: (n, d) => {
      registered[n] = d;
    },
    registerCommand: (cmdName, opts) => {
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
        on("before_agent_start", async (msgs) => {
          if (find(msgs)) return;
          const text = await provider({ messages: msgs });
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

      let cached: string | undefined;
      if (scope === "run")
        on("before_agent_start", async (msgs) => {
          cached = await provider({ messages: msgs });
        });
      const get = async (msgs: UIMessage[]) =>
        scope === "run" ? cached : await provider({ messages: msgs });
      if (position === "system")
        on("instructions", async (_, ctx) => {
          const t = await get(ctx.messages);
          return t ? { append: t } : undefined;
        });
      else
        on("context", async (m, ctx) => {
          const t = await get(ctx.messages);
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
