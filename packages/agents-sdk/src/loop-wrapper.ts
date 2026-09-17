/**
 * loop-wrapper.ts — THE EXPERIMENT. Never exported from index.ts.
 *
 * The same `runAgentLoop` API as loop.ts, implemented as a wrapper over ONE
 * `streamText({ stopWhen })` call, with each moment mapped onto the hook the
 * SDK already offers:
 *
 *   step_start (N ≥ 1)     stopWhen — it is only consulted when the SDK would
 *                          continue, which is exactly when the question arises
 *   step_start (N = 0)     checked before the call; the SDK has no hook there
 *   instructions, context  prepareStep
 *   tool_call, tool_result the same tool wrapper loop.ts uses
 *   chunk, render          the UI chunk stream we forward anyway
 *   steer                  appended to the transcript in stopWhen; prepareStep
 *                          rebuilds the model view from it
 *   step_end               onStepFinish SIGNALS it. The SDK awaits its callbacks
 *                          but discards what they return and swallows what they
 *                          throw (`notify`: `try { await cb() } catch {}`), so
 *                          a fail-closed extension cannot live inside one. The
 *                          work runs in our own code, gated on the signal.
 *   follow_up              IMPOSSIBLE. stopWhen is never consulted when the SDK
 *                          is about to stop, so nothing can revive the run.
 *
 * THE PRICE, made explicit: the SDK never hands out the UIMessage transcript
 * mid-run. `StepContext.messages` — which persistence, markers and notices
 * all read — has to be a shadow, rebuilt at every step boundary by replaying
 * every UI chunk so far through the SDK's own reducer (`readUIMessageStream`).
 * Deterministic, and quadratic in chunks. The step boundary itself is not a
 * value here either: it is two events (the SDK's onStepFinish and our
 * consumer seeing `finish-step`) that must be joined before `step_end` may run.
 *
 * Run the suite against this with `vitest.wrapper.config.ts`; what fails is
 * the true cost of not owning the loop.
 */

import {
  convertToModelMessages,
  createUIMessageStream,
  readUIMessageStream,
  streamText,
  toUIMessageStream,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { compose } from "./compose.js";
import type { Part, Principal, RunContext, StepContext, StepInfo } from "./extension.js";
import {
  appendParts,
  coalesce,
  fireClientToolResults,
  lastUserText,
  renderTranscript,
  replaceLastUserText,
  wrapTools,
  type AgentLoopOptions,
  type BlockedToolOutput,
} from "./loop.js";

export { renderTranscript };
export type { AgentLoopOptions, BlockedToolOutput };

const arrayStream = <T>(items: T[]) =>
  new ReadableStream<T>({
    start(c) {
      for (const i of items) c.enqueue(i);
      c.close();
    },
  });

/**
 * The shadow transcript: the pre-run messages with the streamed assistant
 * message folded in, rebuilt from scratch through the SDK's own reducer so it
 * cannot drift from what `toUIMessageStream` will report at the end.
 */
async function replayTranscript(base: UIMessage[], chunks: UIMessageChunk[]): Promise<UIMessage[]> {
  const last = base[base.length - 1];
  const anchor = last && last.role === "assistant" ? last : undefined;
  let latest: UIMessage | undefined;
  for await (const m of readUIMessageStream({ stream: arrayStream(chunks), message: anchor })) latest = m;
  if (!latest) return base;
  return anchor ? [...base.slice(0, -1), latest] : [...base, latest];
}

/**
 * loop.ts appends a step's `step_end` parts right after that step's parts.
 * A replay only knows the SDK's parts, so put ours back where they belong:
 * each step's appended parts go before the NEXT `step-start`, the last step's
 * at the end. `priorSteps` skips step-start parts the anchor already had.
 */
function interleave(messages: UIMessage[], appendedByStep: Map<number, Part[]>, priorSteps: number): UIMessage[] {
  const i = messages.length - 1;
  const last = messages[i];
  if (!last || last.role !== "assistant") return messages;
  const out: Part[] = [];
  let seen = 0;
  let step = -1;
  for (const p of last.parts as Part[]) {
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
  return [...messages.slice(0, i), { ...last, parts: out } as UIMessage];
}

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

type StepDone = {
  usage: unknown;
  finishReason: string;
  model: { provider: string; modelId: string };
  toolCalls: Array<{ toolName: string; toolCallId: string }>;
};

/** Returns a UI message stream. Hand it to `createUIMessageStreamResponse`. */
export async function runAgentLoop<TOOLS extends ToolSet = ToolSet>(
  opts: AgentLoopOptions<TOOLS>,
): Promise<ReadableStream<UIMessageChunk>> {
  const hooks = compose(opts.extensions ?? [], { onExtensionError: opts.onExtensionError });
  const runId = opts.runId ?? crypto.randomUUID();
  const principal = (opts.principal ?? {}) as Principal;
  const responseMessageId = crypto.randomUUID();
  const run: RunContext = { runId, principal };
  const byStep = opts.stream === "steps";
  const maxSteps = opts.maxSteps ?? 20;

  // --- prepare: identical to loop.ts -----------------------------------------
  const prepared = await (async () => {
    let messages = opts.messages;
    let handled: Part[] | undefined;

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

    if (hooks.has("tool_result"))
      messages = await fireClientToolResults(messages, opts.tools, hooks, run);

    if (handled) return { messages, handled, tools: opts.tools };
    return { messages, handled, tools: wrapTools(hooks.tools(opts.tools, run), hooks, run) as TOOLS };
  })();

  return createUIMessageStream({
    onError: opts.onError ?? ((e) => (e instanceof Error ? e.message : String(e))),
    async execute({ writer }) {
      let messages = prepared.messages;
      let stepCount = 0;
      const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

      const end = (isAborted: boolean, error?: unknown) =>
        hooks.agentEnd({ runId, principal, messages, stepCount, isAborted, error, usage: totals });

      try {
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
            if (!p.type.startsWith("data-")) continue;
            const view = hooks.view(p, false, run);
            if (view && "hide" in view && view.hide) continue;
            const shown = view && "replace" in view && view.replace ? view.replace : p;
            writer.write({ type: shown.type, data: (shown as { data: unknown }).data } as UIMessageChunk);
          }
          writer.write({ type: "finish", finishReason: "stop" } as UIMessageChunk);
          messages = [...messages, { id: responseMessageId, role: "assistant", parts: prepared.handled } as UIMessage];
          await end(false);
          return;
        }

        const tools = prepared.tools;
        const shared = { ...(opts.principal ? { principal } : {}), ...(opts.toolContext ?? {}) };
        const toolsContext =
          Object.keys(shared).length || opts.toolsContext
            ? Object.fromEntries(
                Object.keys(tools).map((name) => [name, { ...shared, ...(opts.toolsContext?.[name] ?? {}) }]),
              )
            : undefined;

        // Step 0 is gated here: the SDK offers no hook before its first call.
        let control = await hooks.stepStart({ runId, principal, stepNumber: 0, messages });
        if (control.stop) {
          writer.write({ type: "finish", finishReason: "other" } as UIMessageChunk);
          await end(false);
          return;
        }

        // --- the step boundary, reconstructed from two events -----------------
        const stepDone = new Map<number, Deferred<StepDone>>();
        const uiDone = new Map<number, Deferred<void>>();
        const settled = new Map<number, Promise<void>>();
        const slot = <T>(m: Map<number, Deferred<T>>, k: number): Deferred<T> => {
          let d = m.get(k);
          if (!d) {
            d = deferred<T>();
            m.set(k, d);
          }
          return d;
        };
        const startedAt = new Map<number, number>();
        const appendedByStep = new Map<number, Part[]>();
        let lastFinishReason = "other";

        const settle = (k: number): Promise<void> => {
          let p = settled.get(k);
          if (p) return p;
          p = (async () => {
            const step = await slot(stepDone, k).promise;
            await slot(uiDone, k).promise;
            const raw = step.usage as
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
            lastFinishReason = step.finishReason;

            const info: StepInfo = {
              runId,
              principal,
              stepNumber: k,
              messages,
              usage,
              finishReason: step.finishReason,
              model: step.model,
              durationMs: Date.now() - (startedAt.get(k) ?? Date.now()),
              toolCalls: step.toolCalls,
            };
            const ctx: StepContext = { runId, principal, stepNumber: k, messages };
            const appended = await hooks.stepEnd(messages, info);
            for (const part of appended) {
              if (!part.type.startsWith("data-")) continue;
              const view = hooks.view(part, false, ctx);
              if (view && "hide" in view && view.hide) continue;
              const shown = view && "replace" in view && view.replace ? view.replace : part;
              for (const out of hooks.chunk({ type: shown.type, data: (shown as { data: unknown }).data } as UIMessageChunk, ctx))
                writer.write(out);
            }
            appendedByStep.set(k, appended);
            messages = appendParts(messages, appended);
            stepCount = k + 1;
          })();
          settled.set(k, p);
          p.catch(() => {}); // surfaces where it is awaited, not as an unhandled rejection
          return p;
        };

        const convertDataPart = (p: unknown) => {
          const e = hooks.dataPart(p as Part, run);
          return e?.text != null ? { type: "text" as const, text: e.text } : undefined;
        };
        const modelView = (): Promise<ModelMessage[]> =>
          convertToModelMessages(messages, { tools, convertDataPart } as never);

        const config = {
          model: opts.model,
          instructions: opts.instructions,
          messages: await modelView(),
          tools,
          abortSignal: opts.abortSignal,
          ...(opts.activeTools ? { activeTools: opts.activeTools } : {}),
          stopWhen: async ({ steps }: { steps: unknown[] }) => {
            const k = steps.length - 1;
            await settle(k);
            if (steps.length >= maxSteps) return true;
            const ctx: StepContext = { runId, principal, stepNumber: steps.length, messages };
            control = await hooks.stepStart(ctx);
            if (control.stop) return true;
            const steered = await hooks.steer("steer", ctx);
            if (steered.length) messages = [...messages, ...steered];
            return false;
          },
          prepareStep: async ({ stepNumber, messages: sdkMessages }: { stepNumber: number; messages: ModelMessage[] }) => {
            if (stepNumber > 0) await settle(stepNumber - 1);
            startedAt.set(stepNumber, Date.now());
            const ctx: StepContext = { runId, principal, stepNumber, messages };
            // Step 0 keeps the SDK's own messages: on a resume it has already
            // executed the approved tool calls and put their results there,
            // and the shadow knows nothing of that yet. Later steps rebuild
            // from the shadow, like loop.ts, so a lens that prepends text does
            // not compound step after step on the SDK's carried-forward view.
            const base = stepNumber === 0 ? sdkMessages : await modelView();
            return {
              ...(control.model ? { model: control.model } : {}),
              ...(control.activeTools ? { activeTools: control.activeTools } : {}),
              instructions: await hooks.instructions(opts.instructions, ctx),
              messages: await hooks.context(base, ctx),
            };
          },
          onStepFinish: async (step: {
            stepNumber: number;
            usage: unknown;
            finishReason: string;
            model: { provider: string; modelId: string };
            response?: { modelId?: string };
            toolCalls: Array<{ toolName: string; toolCallId: string }>;
          }) => {
            slot(stepDone, step.stepNumber).resolve({
              usage: step.usage,
              finishReason: step.finishReason,
              // The model the PROVIDER reports, as loop.ts reads it — pricing
              // keys on that, not on the id the caller configured.
              model: { provider: step.model.provider, modelId: step.response?.modelId ?? step.model.modelId },
              toolCalls: step.toolCalls.map((c) => ({ toolName: c.toolName, toolCallId: c.toolCallId })),
            });
            void settle(step.stepNumber);
          },
          ...(opts.toolApproval ? { toolApproval: opts.toolApproval } : {}),
          ...(opts.providerOptions ? { providerOptions: opts.providerOptions } : {}),
          ...(opts.headers ? { headers: opts.headers } : {}),
          ...(opts.telemetry ? { telemetry: opts.telemetry } : {}),
          ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
          ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
          ...(opts.sandbox ? { experimental_sandbox: opts.sandbox } : {}),
          ...(opts.runtimeContext ? { runtimeContext: opts.runtimeContext } : {}),
          ...(toolsContext ? { toolsContext } : {}),
        };
        const result = streamText(config as never);

        const ui = toUIMessageStream({
          stream: result.stream,
          tools,
          originalMessages: prepared.messages,
          generateMessageId: () => responseMessageId,
          sendStart: true,
          sendFinish: false, // one `finish` for the run, written below, after the last step_end
          onError: opts.onError ?? ((e) => (e instanceof Error ? e.message : String(e))),
        } as Parameters<typeof toUIMessageStream>[0]);

        const anchor = prepared.messages[prepared.messages.length - 1];
        const priorSteps =
          anchor && anchor.role === "assistant"
            ? (anchor.parts as Part[]).filter((p) => p.type === "step-start").length
            : 0;

        // --- consume, forward, and rebuild the shadow at each boundary --------
        const reader = (ui as ReadableStream<unknown>).getReader();
        const all: UIMessageChunk[] = [];
        let held: UIMessageChunk[] = [];
        let k = 0;
        let streamError: unknown;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const c = value as UIMessageChunk;
          all.push(c);
          const ctx: StepContext = { runId, principal, stepNumber: k, messages };
          if ((c as { type: string }).type === "error")
            streamError = new Error(String((c as { errorText?: string }).errorText ?? "stream error"));
          if (byStep) held.push(c);
          else for (const out of hooks.chunk(c, ctx)) writer.write(out);
          if ((c as { type: string }).type === "finish-step") {
            if (byStep) {
              for (const cc of coalesce(held, hooks, ctx)) for (const out of hooks.chunk(cc, ctx)) writer.write(out);
              held = [];
            }
            messages = interleave(await replayTranscript(prepared.messages, all), appendedByStep, priorSteps);
            slot(uiDone, k).resolve();
            void settle(k);
            k++;
          }
        }

        for (let j = 0; j < k; j++) await settle(j);
        if (streamError) throw streamError;
        if (opts.abortSignal?.aborted) {
          await end(true);
          return;
        }
        writer.write({ type: "finish", finishReason: lastFinishReason } as UIMessageChunk);
        await end(false);
      } catch (error) {
        await hooks.error({ error, stepNumber: stepCount, messages }, run);
        await end(false, error);
        throw error;
      }
    },
  });
}
