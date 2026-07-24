import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

const OTEL_KEY = "__latchLangfuseOtel";

interface OtelSingleton {
  provider: NodeTracerProvider;
  processor: LangfuseSpanProcessor;
}

/**
 * Register the global OTEL tracer provider with the Langfuse span processor,
 * once per process. Guarded on `globalThis` so Vite/Nitro SSR module reloads
 * (dev HMR) don't register a second provider. Credentials come from env
 * (`LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL`).
 */
export function ensureTracing(opts?: {
  /** Trace environment shown in Langfuse (e.g. "production" | "development"). */
  environment?: string;
}): LangfuseSpanProcessor {
  const g = globalThis as Record<string, unknown>;
  if (!g[OTEL_KEY]) {
    const processor = new LangfuseSpanProcessor({
      environment: opts?.environment,
    });
    const provider = new NodeTracerProvider({ spanProcessors: [processor] });
    provider.register();
    g[OTEL_KEY] = { provider, processor } satisfies OtelSingleton;
  }
  return (g[OTEL_KEY] as OtelSingleton).processor;
}

/** Flush pending spans to Langfuse (serverless-safe; no-op if never set up). */
export async function flushLangfuse(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const otel = g[OTEL_KEY] as OtelSingleton | undefined;
  await otel?.processor.forceFlush();
}
