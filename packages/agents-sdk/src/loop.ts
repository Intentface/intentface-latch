/**
 * loop.ts — the core. A tool-calling loop we own that stays byte-compatible
 * with `streamText({ stopWhen })`, plus the moments extensions attach to.
 * Nothing else lives here: features are extensions.
 *
 * One `streamText` per step (its default `stopWhen` is `isStepCount(1)`), the
 * transcript threaded through `originalMessages` so every step continues the
 * same assistant message, and the SDK's own continuation test to decide
 * whether to call again.
 *
 * PERSISTENCE is not required by the core. An extension states its own needs;
 * see `Extension.critical` for one that must fail the run rather than be
 * skipped.
 */

import {
  convertToModelMessages,
  createUIMessageStream,
  streamText,
  toUIMessageStream,
  type Instructions,
  type LanguageModel,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { compose, type ComposeOptions } from "./compose.js";
import type { Extension, Part, Principal, RunContext, StepContext, StepInfo } from "./extension.js";

/** Prototype-safe lookup: a tool named `__proto__` must not resolve to Object.prototype. */
const getOwn = <T>(o: Record<string, T>, k: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;

/** What a blocked tool call returns to the model. A result, not a throw, so the reason survives. */
export interface BlockedToolOutput {
  blocked: true;
  reason: string;
}

export interface AgentLoopOptions<TOOLS extends ToolSet = ToolSet> {
  model: LanguageModel;
  tools: TOOLS;
  messages: UIMessage[];
  instructions?: Instructions;
  /** Ceiling on model calls for this run. Extensions stop earlier via `step_start` → `{ stop }`. */
  maxSteps?: number;
  /** Identifies this run to extensions. Generated when omitted. */
  runId?: string;
  /**
   * Who this run is for. Reaches every moment on `StepContext`, and is merged
   * into the context every tool reads, so extensions and tools cannot disagree
   * about identity. Declare its shape once by augmenting `Principal`.
   */
  principal?: Principal;
  /** Cancels the in-flight model call and stops the loop. Emits `abort`, no `finish` — same as vanilla. */
  abortSignal?: AbortSignal;
  /**
   * Error text for tool errors and stream errors.
   *
   * Unlike vanilla, the default here is NOT to mask. `toUIMessageStream`'s
   * stock `onError` writes the literal "An error occurred." into the messages,
   * and because our checkpoint is per step, that masked text is what the MODEL
   * reads on the next step. So the transcript keeps the real message and you
   * mask on the way out with a `render` handler, which applies live and on
   * load alike. Pass a masking function here to restore the SDK's behaviour.
   */
  onError?: (error: unknown) => string;
  /**
   * How much of a step to send before sending any of it.
   *
   *   "deltas" (default)  forward every chunk as it arrives — the live typing
   *                       most chat UIs want.
   *   "steps"             hold a step's chunks until it completes, then send
   *                       them together with each text part coalesced into one.
   *
   * `"steps"` costs responsiveness and buys two things. A reader sees whole
   * thoughts rather than a sentence assembling itself, which suits a log or a
   * digest. And it is the only mode where `render` can act on TEXT: a rule
   * cannot mask a secret that arrives four characters at a time, but it can
   * mask one in a finished paragraph.
   */
  stream?: "deltas" | "steps";
  extensions?: Extension[];
  onExtensionError?: ComposeOptions["onExtensionError"];

  // --- forwarded to streamText, unchanged -----------------------------------
  toolApproval?: unknown;
  activeTools?: string[];
  /** Structural so this package needs no @ai-sdk/provider-utils dependency. */
  providerOptions?: Record<string, Record<string, unknown>>;
  headers?: Record<string, string | undefined>;
  telemetry?: unknown;
  maxOutputTokens?: number;
  maxRetries?: number;
  /** Exposed to sandbox tools as `options.experimental_sandbox`. */
  sandbox?: unknown;
  /**
   * One context object given to EVERY tool, read inside `execute` as
   * `options.context`. This is the usual way to hand tools a principal, a
   * database handle or a secret resolver without a module global.
   *
   * It exists because the SDK's own `toolsContext` is keyed BY TOOL NAME — it
   * looks up `toolsContext[toolName]` — so passing one flat object there
   * silently gives every tool `undefined` with no type error. This is fanned
   * out across the toolset for you.
   */
  toolContext?: Record<string, unknown>;
  /**
   * The SDK's raw per-tool map, when tools genuinely need different context.
   * Merged over `toolContext` per tool.
   */
  toolsContext?: Record<string, Record<string, unknown>>;
  /** Reaches `prepareStep` and approval policies, NOT a tool's `execute`. */
  runtimeContext?: Record<string, unknown>;
}

/** Stored transcript → what the customer may see. Call this in your GET/load route. */
export function renderTranscript(
  extensions: Extension[],
  messages: UIMessage[],
  /** Supply it when the caller knows it — an authenticated load route does. */
  run?: RunContext,
): UIMessage[] {
  const hooks = compose(extensions);
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

/**
 * Wrap every executable tool so `tool_call` can veto and `tool_result` can
 * rewrite what gets stored.
 *
 * `executeTool` sniffs synchronously for `Symbol.asyncIterator`, so a wrapper
 * that returns a promise turns a streaming tool into a non-streaming one: no
 * progress chunks, and a generator object as the output. Two paths follow from
 * that, chosen once per run:
 *
 *   no `tool_call` listener   call `execute` synchronously, pass the iterable
 *                             through, hold one value back so the FINAL yield
 *                             is the hooked one. Streaming preserved.
 *   a `tool_call` listener    the veto is async and must resolve before
 *                             `execute` runs, so the result is a promise and
 *                             progress chunks are collapsed. A gated tool
 *                             cannot also stream; that is the trade.
 */
function wrapTools(tools: ToolSet, hooks: ReturnType<typeof compose>, run: RunContext): ToolSet {
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
    const settle = async (input: unknown, toolCallId: string, output: unknown, isError: boolean) => {
      const e = await hooks.toolResult({ toolName, toolCallId, input, output, isError, source: "server" }, run);
      return e ? e.output : output;
    };

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
            const r = execute.call(t, input, o);
            if (r != null && typeof (r as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
              let held: { v: unknown } | undefined;
              for await (const v of r as AsyncIterable<unknown>) held = { v };
              return settle(input, o.toolCallId, held?.v, false);
            }
            return settle(input, o.toolCallId, await r, false);
          })();
        }

        // Streaming-safe path: no await before `execute`, no await before the sniff.
        const result = execute.call(t, input, o);
        if (result != null && typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
          return (async function* () {
            let held: { v: unknown } | undefined;
            for await (const v of result as AsyncIterable<unknown>) {
              if (held) yield held.v;
              held = { v };
            }
            if (held) yield await settle(input, o.toolCallId, held.v, false);
          })();
        }
        return Promise.resolve(result).then((v) => settle(input, o.toolCallId, v, false));
      },
    };
  }
  return out as ToolSet;
}

/**
 * Fire `tool_result` for outputs a CLIENT produced.
 *
 * A client tool has no server `execute`, so the wrapper in `wrapTools` never
 * sees it: its output arrives in a later request, already in the transcript.
 * Without this, an extension that inspects or redacts tool results silently
 * covers server tools only, while the type promises both.
 *
 * Only parts after the last `step-start` are considered — the same slice the
 * SDK's own auto-resubmit uses — so outputs an earlier run already handled are
 * not fired again.
 */
async function fireClientToolResults(
  messages: UIMessage[],
  tools: ToolSet,
  hooks: ReturnType<typeof compose>,
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

/**
 * Collapse a held step into what a client should receive.
 *
 * Each text part's deltas become a single delta carrying the finished text,
 * which is what lets the `render` rules touch it: masking a secret is possible
 * on a complete paragraph and not on the four-character fragment it arrived in.
 * A rule that hides the part drops its chunks entirely.
 */
function coalesce(
  chunks: UIMessageChunk[],
  hooks: ReturnType<typeof compose>,
  ctx: StepContext,
): UIMessageChunk[] {
  type C = { type: string; id?: string; delta?: string };
  const text = new Map<string, string>();
  for (const c of chunks as C[])
    if (c.type === "text-delta" && c.id) text.set(c.id, (text.get(c.id) ?? "") + (c.delta ?? ""));

  const out: UIMessageChunk[] = [];
  const dropped = new Set<string>();
  for (const c of chunks as C[]) {
    if (c.type === "text-start" && c.id) {
      const view = hooks.view({ type: "text", text: text.get(c.id) ?? "" } as Part, false, ctx);
      if (view && "hide" in view && view.hide) {
        dropped.add(c.id);
        continue;
      }
      if (view && "replace" in view && view.replace)
        text.set(c.id, String((view.replace as { text?: string }).text ?? ""));
      out.push(c as UIMessageChunk);
      continue;
    }
    if (c.id && dropped.has(c.id)) continue;
    // The first delta for an id carries the whole part; later ones are gone.
    if (c.type === "text-delta" && c.id) {
      const whole = text.get(c.id);
      if (whole === undefined) continue;
      text.delete(c.id);
      out.push({ ...c, delta: whole } as UIMessageChunk);
      continue;
    }
    out.push(c as UIMessageChunk);
  }
  return out;
}

/** Append parts produced by `step_end` onto the run's assistant message. */
function appendParts(messages: UIMessage[], parts: Part[]): UIMessage[] {
  if (!parts.length) return messages;
  const i = messages.length - 1;
  const last = messages[i];
  if (!last || last.role !== "assistant") return [...messages, { id: crypto.randomUUID(), role: "assistant", parts } as UIMessage];
  return [...messages.slice(0, i), { ...last, parts: [...(last.parts as Part[]), ...parts] } as UIMessage];
}

const lastUserText = (messages: UIMessage[]): string | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const t = (m.parts as Part[]).find((p) => p.type === "text") as { text?: string } | undefined;
    return t?.text;
  }
  return undefined;
};

const replaceLastUserText = (messages: UIMessage[], text: string): UIMessage[] => {
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

/** Returns a UI message stream. Hand it to `createUIMessageStreamResponse`. */
export async function runAgentLoop<TOOLS extends ToolSet = ToolSet>(
  opts: AgentLoopOptions<TOOLS>,
): Promise<ReadableStream<UIMessageChunk>> {
  const hooks = compose(opts.extensions ?? [], { onExtensionError: opts.onExtensionError });
  const runId = opts.runId ?? crypto.randomUUID();
  const principal = (opts.principal ?? {}) as Principal;
  const responseMessageId = crypto.randomUUID();

  // --- prepare -------------------------------------------------------------
  // Everything that happens before the first chunk runs here, OUTSIDE the
  // stream, so a failure rejects instead of becoming an error chunk. That
  // matters for the persistence extension: a chat already running elsewhere
  // must be a 409, not a stream that opens and then apologises.
  //
  // `createUIMessageStream` catches whatever `execute` throws and emits it as
  // an `error` chunk, always completing normally. Once a byte is out there is
  // no way back, so failures from here on stop the run and surface in-band.
  const run: RunContext = { runId, principal };
  const byStep = opts.stream === "steps";

  const prepared = await (async () => {
    let messages = opts.messages;
    let handled: Part[] | undefined;

    // The start moments run FIRST, even for a command the model never sees. A
    // store has to claim the chat, and — the reason the ORDER matters — it is
    // what supplies the history. A client typically posts only the newest turn,
    // so an `input` handler running ahead of this would see a single message
    // and reason about the conversation as though it had just begun.
    if (!messages.some((m) => m.role === "assistant"))
      messages = await hooks.messagesIn("session_start", messages, run);
    messages = await hooks.messagesIn("before_agent_start", messages, run);

    const text = lastUserText(messages);
    if (text != null) {
      const e = await hooks.input(text, messages, run);
      if (e && "handled" in e && e.handled) {
        const reply = e.reply;
        handled =
          typeof reply === "string"
            ? [{ type: "text", text: reply } as Part]
            : Array.isArray(reply)
              ? reply
              : [];
        if (e.replace) messages = e.replace;
      } else if (e && "transform" in e && e.transform != null) {
        messages = replaceLastUserText(messages, e.transform);
      }
    }

    // Outputs a client produced arrive here, already in the transcript.
    if (hooks.has("tool_result"))
      messages = await fireClientToolResults(messages, opts.tools, hooks, run);

    if (handled) return { messages, handled, tools: opts.tools };
    return { messages, handled, tools: wrapTools(hooks.tools(opts.tools, run), hooks, run) as TOOLS };
  })();

  return createUIMessageStream({
    onError: opts.onError ?? ((e) => (e instanceof Error ? e.message : String(e))),
    async execute({ writer }) {
      let messages = prepared.messages;
      let stepNumber = 0;
      let finishReason = "other";
      const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      // Provider-executed calls whose result is deferred to a later step. The
      // SDK tracks this inside one streamText call; ours are separate calls.
      const pendingDeferred = new Set<string>();

      const end = (isAborted: boolean, error?: unknown) =>
        hooks.agentEnd({ runId, principal, messages, stepCount: stepNumber, isAborted, error, usage: totals });

      try {
        // A command answered without the model. Emit it as an ordinary turn so
        // the conversation still reads normally.
        if (prepared.handled) {
          writer.write({ type: "start", messageId: responseMessageId } as UIMessageChunk);
          for (const p of prepared.handled) {
            if (p.type === "text") {
              const id = crypto.randomUUID();
              writer.write({ type: "text-start", id } as UIMessageChunk);
              writer.write({ type: "text-delta", id, delta: (p as { text: string }).text } as UIMessageChunk);
              writer.write({ type: "text-end", id } as UIMessageChunk);
              continue;
            }
            // Data parts stream too. A command's reply is the only place an
            // extension can hand the CLIENT something structured without a
            // model call, and dropping them here made `/compact` unable to tell
            // the browser its history had just been rewritten.
            if (!p.type.startsWith("data-")) continue;
            const view = hooks.view(p, false, run);
            if (view && "hide" in view && view.hide) continue;
            const shown = view && "replace" in view && view.replace ? view.replace : p;
            writer.write({
              type: shown.type,
              data: (shown as { data: unknown }).data,
            } as UIMessageChunk);
          }
          writer.write({ type: "finish", finishReason: "stop" } as UIMessageChunk);
          messages = [
            ...messages,
            { id: responseMessageId, role: "assistant", parts: prepared.handled } as UIMessage,
          ];
          await end(false);
          return;
        }

        const tools = prepared.tools;

        // `toolsContext` is keyed by tool name, so fan the shared context out
        // across the toolset. Per-tool entries win over the shared one.
        // The principal joins it automatically, so a tool reads the same
        // identity an extension sees rather than being handed a second copy.
        const shared = {
          ...(opts.principal ? { principal } : {}),
          ...(opts.toolContext ?? {}),
        };
        const toolsContext = Object.keys(shared).length || opts.toolsContext
          ? Object.fromEntries(
              Object.keys(tools).map((name) => [
                name,
                { ...shared, ...(opts.toolsContext?.[name] ?? {}) },
              ]),
            )
          : undefined;

        while (stepNumber < (opts.maxSteps ?? 20)) {
          if (opts.abortSignal?.aborted) break;
          const ctx: StepContext = { runId, principal, stepNumber, messages };

          const control = await hooks.stepStart(ctx);
          if (control.stop) break;

          const startedAt = Date.now();
          const result = streamText({
            model: control.model ?? opts.model,
            instructions: await hooks.instructions(opts.instructions, ctx),
            messages: await hooks.context(
              await convertToModelMessages(messages, {
                tools,
                convertDataPart: (p) => {
                  const e = hooks.dataPart(p as Part, ctx);
                  return e?.text != null ? { type: "text", text: e.text } : undefined;
                },
              }),
              ctx,
            ),
            tools,
            abortSignal: opts.abortSignal,
            ...(control.activeTools ?? opts.activeTools
              ? { activeTools: (control.activeTools ?? opts.activeTools) as never }
              : {}),
            ...(opts.toolApproval ? { toolApproval: opts.toolApproval as never } : {}),
            ...(opts.providerOptions ? { providerOptions: opts.providerOptions } : {}),
            ...(opts.headers ? { headers: opts.headers } : {}),
            ...(opts.telemetry ? { telemetry: opts.telemetry as never } : {}),
            ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
            ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
            ...(opts.sandbox ? { experimental_sandbox: opts.sandbox as never } : {}),
            ...(opts.runtimeContext ? { runtimeContext: opts.runtimeContext as never } : {}),
            ...(toolsContext ? { toolsContext: toolsContext as never } : {}),
          } as Parameters<typeof streamText>[0]);

          let next: UIMessage[] | undefined;
          const ui = toUIMessageStream({
            stream: result.stream,
            tools, // dynamic-tool classification needs it
            // Ending in an assistant message → the SDK reuses its id and merges
            // new parts into it: one message across steps.
            originalMessages: messages,
            generateMessageId: () => responseMessageId,
            sendStart: stepNumber === 0,
            sendFinish: false, // one `finish` for the run, below
            onError: opts.onError ?? ((e) => (e instanceof Error ? e.message : String(e))),
            onFinish: ({ messages: m }) => {
              next = m as UIMessage[];
            },
          } as Parameters<typeof toUIMessageStream>[0]);

          // A reader rather than `for await`: the DOM lib's ReadableStream has
          // no Symbol.asyncIterator, and this package targets both runtimes.
          const reader = (ui as ReadableStream<unknown>).getReader();
          const buffered: UIMessageChunk[] = [];
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (byStep) buffered.push(value as UIMessageChunk);
            else for (const c of hooks.chunk(value as UIMessageChunk, ctx)) writer.write(c);
          }
          // One streamText call is one step, so the end of this stream is the
          // step boundary. Flush what was held, coalesced and viewed.
          if (byStep)
            for (const c of coalesce(buffered, hooks, ctx))
              for (const out of hooks.chunk(c, ctx)) writer.write(out);
          if (!next) throw new Error("toUIMessageStream produced no messages");
          messages = next;

          if (opts.abortSignal?.aborted) {
            await end(true);
            return;
          }

          finishReason = (await result.finishReason) as string;
          // The SDK flattens the provider's nested counts and puts the cache
          // split under `*TokenDetails`. Lift it so an extension sees one shape.
          const raw = (await result.usage) as
            | {
                inputTokens?: number;
                outputTokens?: number;
                totalTokens?: number;
                inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
                outputTokenDetails?: { reasoningTokens?: number };
              }
            | undefined;
          const usage: StepInfo["usage"] = {
            inputTokens: raw?.inputTokens,
            outputTokens: raw?.outputTokens,
            totalTokens: raw?.totalTokens,
            cacheReadTokens: raw?.inputTokenDetails?.cacheReadTokens,
            cacheWriteTokens: raw?.inputTokenDetails?.cacheWriteTokens,
            reasoningTokens: raw?.outputTokenDetails?.reasoningTokens,
          };
          totals.inputTokens += usage.inputTokens ?? 0;
          totals.outputTokens += usage.outputTokens ?? 0;
          totals.totalTokens += usage.totalTokens ?? 0;
          totals.cacheReadTokens += usage.cacheReadTokens ?? 0;
          totals.cacheWriteTokens += usage.cacheWriteTokens ?? 0;

          const toolCalls = await result.toolCalls;
          const content = await result.content;

          const info: StepInfo = {
            runId,
            principal,
            stepNumber,
            messages,
            usage: usage ?? {},
            finishReason,
            model: { provider: "", modelId: (await result.response)?.modelId ?? "" },
            durationMs: Date.now() - startedAt,
            toolCalls: toolCalls.map((c) => ({ toolName: c.toolName, toolCallId: c.toolCallId })),
          };
          // Parts from `step_end` are both stored AND streamed. Storing alone
          // would mean a notice only appeared after a reload, which is the
          // opposite of what a per-step notice is for. No `id` is set, so each
          // one appends rather than replacing the last.
          const appended = await hooks.stepEnd(messages, info);
          for (const part of appended) {
            if (!part.type.startsWith("data-")) continue;
            // The view rules apply to the LIVE stream too, not just on load.
            // Without this a `render` rule that hides a part would still let it
            // through while streaming and only hide it after a reload.
            const view = hooks.view(part, false, ctx);
            if (view && "hide" in view && view.hide) continue;
            const shown = view && "replace" in view && view.replace ? view.replace : part;
            for (const out of hooks.chunk(
              { type: shown.type, data: (shown as { data: unknown }).data } as UIMessageChunk,
              ctx,
            ))
              writer.write(out);
          }
          // Storage keeps the truth, whatever the reader was shown.
          messages = appendParts(messages, appended);

          stepNumber += 1;

          // Mirrors stream-text.ts (which does not consult finishReason):
          // continue iff every client call is answered — by a result, an error,
          // or a denied approval — AND there was such a call, or a deferred
          // provider result is still pending.
          type Output = { type: string; toolCallId: string; providerExecuted?: boolean };
          const parts = content as unknown as Output[];
          const outputs = parts.filter((p) => p.type === "tool-result" || p.type === "tool-error");
          const deniedIds = new Set(
            parts
              .filter(
                (p) =>
                  p.type === "tool-approval-response" &&
                  (p as unknown as { approved?: boolean }).approved === false,
              )
              .map((p) => p.toolCallId),
          );
          for (const o of outputs) pendingDeferred.delete(o.toolCallId);
          for (const c of toolCalls) {
            const t = getOwn(tools as Record<string, unknown>, c.toolName) as
              | { type?: string; supportsDeferredResults?: boolean }
              | undefined;
            if (
              c.providerExecuted &&
              t?.type === "provider" &&
              t.supportsDeferredResults &&
              !outputs.some((o) => o.toolCallId === c.toolCallId)
            )
              pendingDeferred.add(c.toolCallId);
          }
          const local = toolCalls.filter((c) => c.providerExecuted !== true);
          const answered = new Set([
            ...outputs.filter((o) => o.providerExecuted !== true).map((o) => o.toolCallId),
            ...deniedIds,
          ]);
          let carryOn =
            local.every((c) => answered.has(c.toolCallId)) &&
            (local.length > 0 || pendingDeferred.size > 0);

          const ctxAfter: StepContext = { runId, principal, stepNumber, messages };
          if (carryOn) {
            const steered = await hooks.steer("steer", ctxAfter);
            if (steered.length) messages = [...messages, ...steered];
          } else {
            // The run is about to end. An extension may revive it.
            const more = await hooks.steer("follow_up", ctxAfter);
            if (more.length) {
              messages = [...messages, ...more];
              carryOn = true;
            }
          }
          if (!carryOn) break;
        }

        writer.write({ type: "finish", finishReason } as UIMessageChunk);
        await end(false);
      } catch (error) {
        await hooks.error({ error, stepNumber, messages }, { runId, principal });
        await end(false, error);
        throw error;
      }
    },
  });
}
