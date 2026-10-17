import type { LatchTelemetry, TelemetryRunMeta, TelemetryRunOutcome, TurnTrigger } from "@intentface/latch-core";
import { OpenTelemetry, type OpenTelemetryOptions } from "@ai-sdk/otel";
import { context, SpanStatusCode, trace, type Attributes, type Context, type Span } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  RandomIdGenerator,
  type IdGenerator,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { traceIdForRun } from "./trace-id.js";

/** What a run's spans are labelled with: what latch knows about the run when it starts. */
export interface OtelRun {
  runId: string;
  chatId: string;
  /** The top-level conversation: a subagent's run shares it with the run that spawned it. */
  sessionId: string;
  agent: string;
  modelId: string;
  /** 0 for a top-level turn, more for a subagent. */
  depth: number;
  trigger: TurnTrigger;
  /** The stored agent version behind the run, for agents that come from a store. */
  agentVersion?: number;
  /** The run that spawned this one, for a subagent. */
  parentRunId?: string;
  /** From `user`. */
  user?: string;
  /** From `agentOwner`. */
  agentOwner?: string;
  /** From `environment`. */
  environment?: string;
}

/**
 * Where spans go, and anything that backend wants on them beyond the standard
 * attributes. `langfuse()` from `@intentface/latch-otel/langfuse` is one.
 */
export interface OtelDestination {
  exporter: SpanExporter;
  /** Attributes for every span of a run (`everySpan`), and for the run's own span (`root`). */
  runAttributes?(run: OtelRun): { everySpan?: Attributes; root?: Attributes };
  /** Attributes for the run's own span once the run has finished. */
  finishedAttributes?(run: OtelRun, outcome: TelemetryRunOutcome): Attributes | undefined;
}

export interface OtelTelemetryOptions<P> {
  /**
   * Where spans go: an exporter, or a destination such as `langfuse()`.
   * Default: OTLP over HTTP to `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (or
   * `OTEL_EXPORTER_OTLP_ENDPOINT`), with `OTEL_EXPORTER_OTLP_HEADERS`.
   */
  export?: SpanExporter | OtelDestination;
  /**
   * Who a run is for, as one stable string (usually the owner key). Becomes
   * `user.id`. Leave it out to record no user.
   */
  user?: (principal: P) => string;
  /**
   * Who owns the agent being run, when that's someone other than the user (an
   * org's shared agent). Becomes `latch.agent_owner`. Runs before every turn,
   * so keep it cheap; a throw only loses the attribute.
   */
  agentOwner?: (run: TelemetryRunMeta<P>) => Promise<string | undefined>;
  /** `deployment.environment.name`, e.g. "production". */
  environment?: string;
  /** More attributes for every span of a run. */
  attributes?: (run: TelemetryRunMeta<P>) => Attributes | undefined;
  /** Options for the AI SDK's spans (`@ai-sdk/otel`), e.g. `{ usage: true }`. */
  aiSdk?: Omit<OpenTelemetryOptions, "tracer">;
  /**
   * Keeps the flush alive after the response on serverless (Vercel's
   * `waitUntil`). Without it, flush is only awaited.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Default true. False turns every hook into a no-op. */
  enabled?: boolean;
}

/** Run attributes carried in the context, copied onto every span the run starts. */
const RUN_ATTRIBUTES = Symbol.for("latch-otel.run-attributes");

let contextManagerSet = false;
/**
 * Spans only nest across `await`s with an async context manager. Register one
 * unless the app already has: `setGlobalContextManager` refuses a second.
 */
function ensureContextManager() {
  if (contextManagerSet) return;
  contextManagerSet = true;
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
}

/** Text of the last assistant message: the run's output. */
function lastAssistantText(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; parts?: Array<{ type?: string; text?: string }> } | undefined;
    if (m?.role !== "assistant") continue;
    const text = (m.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join(" ")
      .trim();
    return text || undefined;
  }
  return undefined;
}

const defined = (a: Record<string, string | number | boolean | undefined>): Attributes =>
  Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) as Attributes;

/** The standard attributes, on every span of a run. */
function standardAttributes(run: OtelRun): Attributes {
  return defined({
    "session.id": run.sessionId,
    "user.id": run.user,
    "gen_ai.conversation.id": run.sessionId,
    "gen_ai.agent.name": run.agent,
    "deployment.environment.name": run.environment,
    "latch.run.id": run.runId,
    "latch.chat.id": run.chatId,
    "latch.agent": run.agent,
    "latch.agent.version": run.agentVersion,
    "latch.agent_owner": run.agentOwner,
    "latch.parent_run.id": run.parentRunId,
    "latch.depth": run.depth,
    "latch.trigger": run.trigger,
  });
}

/**
 * Latch's telemetry hook over OpenTelemetry. Each run is one trace, its id
 * derived from the run id (`traceIdForRun`), rooted in a `latch.run <agent>`
 * span: the whole turn, saving it included. The AI SDK's own spans (its
 * `invoke_agent`, each step, each model call and tool call, in the GenAI
 * semantic conventions, from `@ai-sdk/otel`) nest under it. Every span carries the session, the user and
 * the run, so a backend can filter on any of them.
 *
 * ```ts
 * import { otelTelemetry } from "@intentface/latch-otel";
 * import { langfuse } from "@intentface/latch-otel/langfuse";
 *
 * createRuntime({
 *   ...,
 *   telemetry: otelTelemetry({ user: (p) => ownerKey(p), export: langfuse() }),
 * });
 * ```
 *
 * It runs its own tracer provider, so it neither needs nor replaces one your
 * app registered. Add `@ai-sdk/otel` at the version matching your `ai`.
 */
export function otelTelemetry<P>(opts: OtelTelemetryOptions<P> = {}): LatchTelemetry<P> {
  if (opts.enabled === false) return {};
  const destination: OtelDestination =
    opts.export && "exporter" in opts.export ? opts.export : { exporter: opts.export ?? new OTLPTraceExporter() };

  // The next root span's trace id. Set right before `startSpan` and consumed by
  // it, synchronously, so a root span gets the run's id and nothing else does.
  let nextTraceId: string | undefined;
  const random = new RandomIdGenerator();
  const idGenerator: IdGenerator = {
    generateTraceId: () => {
      const id = nextTraceId ?? random.generateTraceId();
      nextTraceId = undefined;
      return id;
    },
    generateSpanId: () => random.generateSpanId(),
  };
  const propagate: SpanProcessor = {
    onStart(span, parent: Context) {
      const attributes = parent.getValue(RUN_ATTRIBUTES) as Attributes | undefined;
      if (attributes) span.setAttributes(attributes);
    },
    onEnd() {},
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  const provider = new BasicTracerProvider({
    idGenerator,
    spanProcessors: [propagate, new BatchSpanProcessor(destination.exporter)],
  });
  const tracer = provider.getTracer("@intentface/latch-otel");
  const aiSdk = new OpenTelemetry({ ...opts.aiSdk, tracer });
  // The run's span stays open until the run finishes, for a real duration and its output.
  const open = new Map<string, { span: Span; run: OtelRun }>();

  return {
    telemetryFor(run) {
      return { isEnabled: true, functionId: `agent:${run.agent}`, integrations: [aiSdk] };
    },

    async withRunSpan(meta, fn) {
      ensureContextManager();
      let agentOwner: string | undefined;
      try {
        agentOwner = await opts.agentOwner?.(meta);
      } catch (e) {
        console.warn(`latch-otel: agentOwner failed (run ${meta.runId}):`, e);
      }
      const run: OtelRun = {
        runId: meta.runId,
        chatId: meta.chatId,
        sessionId: meta.rootChatId ?? meta.chatId,
        agent: meta.agent,
        modelId: meta.modelId,
        depth: meta.depth,
        trigger: meta.trigger,
        agentVersion: meta.agentVersion,
        parentRunId: meta.parentRunId,
        user: opts.user?.(meta.principal),
        agentOwner,
        environment: opts.environment,
      };
      const extra = destination.runAttributes?.(run);
      const everySpan = { ...standardAttributes(run), ...opts.attributes?.(meta), ...extra?.everySpan };
      nextTraceId = await traceIdForRun(meta.runId);
      const span = tracer.startSpan(`latch.run ${meta.agent}`, {
        root: true,
        attributes: { ...everySpan, "latch.model": meta.modelId, ...extra?.root },
      });
      nextTraceId = undefined;
      open.set(meta.runId, { span, run });
      const ctx = trace.setSpan(context.active().setValue(RUN_ATTRIBUTES, everySpan), span);
      return context.with(ctx, fn);
    },

    async onRunFinished(meta, outcome) {
      const entry = open.get(meta.runId);
      if (!entry) return;
      open.delete(meta.runId);
      const { span, run } = entry;
      span.setAttributes(
        defined({
          "input.value": outcome.inputText,
          "output.value": lastAssistantText(outcome.messages),
          "latch.run.status": outcome.status,
          "latch.usage.input_tokens": outcome.usage.inputTokens,
          "latch.usage.output_tokens": outcome.usage.outputTokens,
          "latch.usage.cache_read_tokens": outcome.usage.cacheReadTokens,
          "latch.usage.cache_write_tokens": outcome.usage.cacheWriteTokens,
          "latch.cost": outcome.cost,
        }),
      );
      const finished = destination.finishedAttributes?.(run, outcome);
      if (finished) span.setAttributes(finished);
      if (outcome.status === "errored") span.setStatus({ code: SpanStatusCode.ERROR, message: outcome.error });
      span.end();
    },

    async flush() {
      const done = provider.forceFlush();
      opts.waitUntil?.(done.catch(() => {}));
      await done;
    },
  };
}
