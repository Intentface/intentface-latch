import { LangfuseClient } from "@langfuse/client";

/**
 * True when Langfuse credentials are present (`LANGFUSE_PUBLIC_KEY` +
 * `LANGFUSE_SECRET_KEY`; `LANGFUSE_BASE_URL` optional, defaults to
 * cloud.langfuse.com). The telemetry seam should be left undefined otherwise.
 */
export function isLangfuseConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY,
  );
}

const CLIENT_KEY = "__latchLangfuseClient";

/**
 * Process-wide `LangfuseClient` (reads credentials from env). Cached on
 * `globalThis` so Vite SSR module reloads don't multiply clients.
 */
export function getLangfuseClient(): LangfuseClient {
  const g = globalThis as Record<string, unknown>;
  if (!g[CLIENT_KEY]) g[CLIENT_KEY] = new LangfuseClient();
  return g[CLIENT_KEY] as LangfuseClient;
}
