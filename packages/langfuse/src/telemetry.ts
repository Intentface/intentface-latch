import type {
  LatchTelemetry,
  TelemetryRunMeta,
  TelemetryRunOutcome,
} from "@intentface/latch-core";
import type { TelemetryOptions } from "ai";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import {
  propagateAttributes,
  startObservation,
  type LangfuseAgent,
} from "@langfuse/tracing";
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api";
import { ensureTracing, flushLangfuse } from "./otel.js";
import { isLangfuseConfigured } from "./client.js";
import { traceIdForRun } from "./trace-id.js";

export interface LangfuseTelemetryOptions<P> {
  /**
   * Tenant isolation tag derived from the principal (e.g. the platform's
   * owner key). Becomes the trace's `userId` and an `owner:` tag — all
   * platform reads filter on it, so it must be stable per tenant.
   */
  ownerTag: (principal: P) => string;
  /**
   * The owner key of the AGENT being run, when the host can resolve one — becomes
   * an `agent-owner:` tag. Distinct from `ownerTag` (who ran the turn): it lets a
   * reader find every run of the agents it administers, including runs by other
   * users. Return undefined for agents with no owner (e.g. code-registry ones),
   * which simply omits the tag. Runs on the turn's hot path, so keep it cheap.
   */
  agentOwnerTag?: (run: TelemetryRunMeta<P>) => Promise<string | undefined>;
  /** Trace environment shown in Langfuse (default "development"). */
  environment?: string;
  /**
   * Post-trace extension point — the platform hangs the online judge here.
   * Runs after the run's root span is finalized.
   */
  afterRun?: (args: {
    meta: TelemetryRunMeta<P>;
    outcome: TelemetryRunOutcome;
    traceId: string;
  }) => Promise<void>;
  /**
   * Serverless background scheduler (e.g. Vercel's `waitUntil`). When set,
   * `afterRun` is scheduled instead of awaited so it never delays the
   * response; locally it's awaited inline.
   */
  waitUntil?: (p: Promise<unknown>) => void;
  /** Override enablement (default: keys present in env). */
  enabled?: boolean;
}

/** A random 16-hex OTEL span id (parent seed for the deterministic trace). */
function randomSpanId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Text of the last assistant message (for trace-level output). */
function lastAssistantText(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as
      | { role?: string; parts?: Array<{ type?: string; text?: string }> }
      | undefined;
    if (m?.role !== "assistant") continue;
    const text = (m.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join(" ")
      .trim();
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

/**
 * The one-liner Langfuse implementation of latch-core's telemetry seam.
 *
 * ```ts
 * const runtime = createRuntime({
 *   ...,
 *   telemetry: isLangfuseConfigured()
 *     ? langfuseTelemetry({ ownerTag: (p) => ownerKey(p) })
 *     : undefined,
 * });
 * ```
 *
 * Every run becomes one Langfuse trace with a deterministic id derived from
 * the runId (`traceIdForRun`), tagged `owner:` / `agent:` / `run:` (plus
 * `agent-owner:` when `agentOwnerTag` resolves one) and scoped to
 * `sessionId = chatId`, `userId = ownerTag`.
 */
export function langfuseTelemetry<P>(
  opts: LangfuseTelemetryOptions<P>,
): LatchTelemetry<P> {
  const enabled = opts.enabled ?? isLangfuseConfigured();
  const integration = new LangfuseVercelAiSdkIntegration();
  // The run's root span stays open until onRunFinished so the trace gets a
  // real duration + trace-level input/output. Keyed by runId (one per turn).
  const openSpans = new Map<string, LangfuseAgent>();

  return {
    telemetryFor(run): TelemetryOptions | undefined {
      if (!enabled) return undefined;
      return {
        isEnabled: true,
        functionId: `agent:${run.agent}`,
        integrations: [integration],
      };
    },

    async withRunSpan(run, fn) {
      if (!enabled) return fn();
      ensureTracing({ environment: opts.environment ?? "development" });
      const owner = opts.ownerTag(run.principal);
      // Seed the root span with the deterministic trace id so scores and
      // feedback can address the trace from the runId alone.
      const span = startObservation(
        run.agent,
        {},
        {
          asType: "agent",
          parentSpanContext: {
            traceId: await traceIdForRun(run.runId),
            spanId: randomSpanId(),
            traceFlags: 1,
          },
        },
      );
      openSpans.set(run.runId, span);
      // Run the model call with the root span active: the AI SDK integration
      // roots its spans in the active context, and propagated attributes
      // (trace name/session/user/tags) flow to every child span.
      const ctx = otelTrace.setSpan(otelContext.active(), span.otelSpan);
      // Group a whole delegation tree under one session: subagent turns run in
      // their own `sub_…` chat, so keying the session on the ROOT conversation
      // (threaded down by the runtime) makes the main turn and its helpers show
      // together in Langfuse. A `parent-run:` tag links each helper to the run
      // that spawned it; `depth` (0 = top-level) records how deep it nested.
      const sessionId = run.rootChatId ?? run.chatId;
      const tags = [`owner:${owner}`, `agent:${run.agent}`, `run:${run.runId}`];
      if (run.parentRunId) tags.push(`parent-run:${run.parentRunId}`, "subagent");
      // `agent-owner:` is how the observability feed finds runs of the agents a
      // reader administers — including runs by OTHER users. Best-effort: a failed
      // lookup must not cost the turn its trace, it only costs that filter.
      if (opts.agentOwnerTag) {
        try {
          const agentOwner = await opts.agentOwnerTag(run);
          if (agentOwner) tags.push(`agent-owner:${agentOwner}`);
        } catch (e) {
          console.warn(`agentOwnerTag failed (run ${run.runId}):`, e);
        }
      }
      return otelContext.with(ctx, () =>
        propagateAttributes(
          {
            traceName: run.agent,
            sessionId,
            userId: owner,
            tags,
            metadata: {
              runId: run.runId,
              chatId: run.chatId,
              agent: run.agent,
              model: run.modelId,
              depth: String(run.depth),
              ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
            },
          },
          fn,
        ),
      );
    },

    async onRunFinished(run, outcome) {
      if (!enabled) return;
      const span = openSpans.get(run.runId);
      if (span) {
        openSpans.delete(run.runId);
        const input = outcome.inputText;
        const output = lastAssistantText(outcome.messages);
        span.update({
          input,
          output,
          level: outcome.status === "errored" ? "ERROR" : "DEFAULT",
          statusMessage: outcome.error,
        });
        // Trace-level IO (what the trace list/preview shows).
        span.setTraceIO({ input, output });
        span.end();
      }
      if (opts.afterRun) {
        const work = (async () => {
          await opts.afterRun!({
            meta: run,
            outcome,
            traceId: await traceIdForRun(run.runId),
          });
        })();
        if (opts.waitUntil) opts.waitUntil(work.catch(() => {}));
        else await work;
      }
    },

    async flush() {
      if (!enabled) return;
      const p = flushLangfuse();
      // Keep the flush alive in serverless even when the caller can't await it
      // (e.g. core's synchronous onError path voids the promise). waitUntil
      // registers it with the platform; we still await for the normal path.
      opts.waitUntil?.(p.catch(() => {}));
      await p;
    },
  };
}
