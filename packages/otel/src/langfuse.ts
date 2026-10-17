import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { OtelDestination, OtelRun } from "./telemetry.js";

export interface LangfuseOptions {
  /** Default `LANGFUSE_PUBLIC_KEY`. */
  publicKey?: string;
  /** Default `LANGFUSE_SECRET_KEY`. */
  secretKey?: string;
  /** Default `LANGFUSE_BASE_URL`, else Langfuse Cloud EU (`https://cloud.langfuse.com`). */
  baseUrl?: string;
  /** Langfuse's environment for these traces. Default: `otelTelemetry`'s `environment`. */
  environment?: string;
  /** Send through this exporter instead of the OTLP one `langfuseOtlp` describes (a proxy, a test). */
  exporter?: SpanExporter;
}

const env = (name: string) => (typeof process === "undefined" ? undefined : process.env[name]) || undefined;

/** Whether the Langfuse keys are in the environment: `langfuse()` with no arguments would work. */
export function isLangfuseConfigured(): boolean {
  return Boolean(env("LANGFUSE_PUBLIC_KEY") && env("LANGFUSE_SECRET_KEY"));
}

/** Langfuse's OTLP endpoint and headers, for an exporter of your own. */
export function langfuseOtlp(opts: Pick<LangfuseOptions, "publicKey" | "secretKey" | "baseUrl"> = {}): {
  url: string;
  headers: Record<string, string>;
} {
  const publicKey = opts.publicKey ?? env("LANGFUSE_PUBLIC_KEY");
  const secretKey = opts.secretKey ?? env("LANGFUSE_SECRET_KEY");
  if (!publicKey || !secretKey) {
    throw new Error("langfuse(): set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY, or pass publicKey and secretKey");
  }
  const baseUrl = (opts.baseUrl ?? env("LANGFUSE_BASE_URL") ?? "https://cloud.langfuse.com").replace(/\/+$/, "");
  return {
    url: `${baseUrl}/api/public/otel/v1/traces`,
    headers: {
      Authorization: `Basic ${btoa(`${publicKey}:${secretKey}`)}`,
      // Ingest as spans arrive rather than in Langfuse's batch path.
      "x-langfuse-ingestion-version": "4",
    },
  };
}

/** The tags a run's trace gets: what Langfuse's trace list filters on. */
function tagsOf(run: OtelRun): string[] {
  const tags = [`agent:${run.agent}`, `run:${run.runId}`];
  if (run.user) tags.unshift(`owner:${run.user}`);
  if (run.parentRunId) tags.push(`parent-run:${run.parentRunId}`, "subagent");
  if (run.agentVersion != null) tags.push(`agent-version:${run.agentVersion}`);
  if (run.agentOwner) tags.push(`agent-owner:${run.agentOwner}`);
  return tags;
}

/**
 * Send traces to Langfuse, over its OTLP endpoint. Each run is one trace named
 * after the agent, in the conversation's session, with the user, tags
 * (`owner:`, `agent:`, `run:`, `agent-version:`, `parent-run:`,
 * `agent-owner:`) and run metadata Langfuse filters on. The run's own span is
 * an agent observation, marked as an error when the run errored.
 *
 * ```ts
 * otelTelemetry({ user: (p) => ownerKey(p), export: langfuse() })
 * ```
 *
 * Reads `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL`;
 * throws without the keys (check `isLangfuseConfigured()` first if they're
 * optional).
 */
export function langfuse(opts: LangfuseOptions = {}): OtelDestination {
  const exporter = opts.exporter ?? new OTLPTraceExporter(langfuseOtlp(opts));
  return {
    exporter,
    runAttributes(run) {
      const environment = opts.environment ?? run.environment;
      return {
        everySpan: {
          "langfuse.trace.name": run.agent,
          "langfuse.session.id": run.sessionId,
          ...(run.user ? { "langfuse.user.id": run.user } : {}),
          "langfuse.trace.tags": tagsOf(run),
          "langfuse.trace.metadata.runId": run.runId,
          "langfuse.trace.metadata.chatId": run.chatId,
          "langfuse.trace.metadata.agent": run.agent,
          "langfuse.trace.metadata.model": run.modelId,
          "langfuse.trace.metadata.depth": String(run.depth),
          ...(run.agentVersion != null ? { "langfuse.trace.metadata.agentVersion": String(run.agentVersion) } : {}),
          ...(run.parentRunId ? { "langfuse.trace.metadata.parentRunId": run.parentRunId } : {}),
          ...(environment ? { "langfuse.environment": environment } : {}),
        },
        root: { "langfuse.observation.type": "agent" },
      };
    },
    finishedAttributes(_run, outcome) {
      if (outcome.status !== "errored") return undefined;
      return {
        "langfuse.observation.level": "ERROR",
        ...(outcome.error ? { "langfuse.observation.status_message": outcome.error } : {}),
      };
    },
  };
}
