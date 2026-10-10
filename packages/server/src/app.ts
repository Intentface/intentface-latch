import {
  createIntervalScheduler,
  createRuntime,
  defineContext,
  type AgentFactory,
  type ContextDefinition,
  type Runtime,
  type RuntimeConfig,
  type Scheduler,
  type StorageAdapter,
} from "@intentface/latch-core";
import { loadModelCatalog, providerDefaults, type ModelCatalog } from "@intentface/latch-core/models";
import { defaultHarnessTools } from "@intentface/latch-core/harness";
import { createLatchHandler, type LatchHandler, type LatchHandlerConfig } from "./handler.js";
import { createCronerEvaluator } from "./cron.js";

/**
 * `createLatchApp` — the composition root you'd otherwise write by hand.
 *
 * Given storage, agents and how to resolve the caller, it wires the runtime
 * with the defaults every host wants (durability on, croner cron evaluator,
 * the models.dev catalog with pricing / reasoning / web-tool / prompt-caching
 * hooks, the default harness tools), mounts the HTTP handler over it, and —
 * on a long-running process — drives `runtime.cron()` on an interval. Every
 * default is overridable through `runtime` / `handler`; anything a host wants
 * beyond the defaults (connections, memory, telemetry) goes in the same way.
 *
 * A hello-world is the storage adapter plus one agent; see `apps/example`.
 */
export interface LatchAppConfig<P, RC = unknown> {
  /** The storage adapter (e.g. `createSqliteAdapter(db, { owner })`). */
  storage: StorageAdapter<P>;
  /**
   * The agent registry — or a function of the loaded model catalog, so agents
   * can pick their model from `models.modelFor(...)` without loading the
   * catalog themselves.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each agent declares its own params
  agents: Record<string, AgentFactory<P, any, any>> | ((models: ModelCatalog) => Record<string, AgentFactory<P, any, any>>);
  /** Your auth: request → Principal (null → 401). */
  resolveContext: LatchHandlerConfig<P>["resolveContext"];
  /** Per-turn runtime context (default: `{}`). */
  context?: ContextDefinition<P, RC>;
  /** A preloaded model catalog (default: `loadModelCatalog()`). */
  models?: ModelCatalog;
  /** Per-principal cache-key suffix for memory-scoped prompt caching (typically the owner key). */
  principalKey?: (principal: P) => string;
  /** Anything else on the runtime — or overrides of the defaults (listed last wins). */
  runtime?: Partial<Omit<RuntimeConfig<P, RC>, "storage" | "agents" | "context">>;
  /** Handler options beyond `runtime` / `resolveContext` (basePath, connections, cronSecret, …). */
  handler?: Partial<Omit<LatchHandlerConfig<P>, "runtime" | "resolveContext">>;
  /**
   * In-process cron cadence (ms) driving `runtime.cron()`. Default 30s on a
   * long-running process; `false` to disable. Auto-disabled on serverless
   * (VERCEL / AWS_LAMBDA_FUNCTION_NAME set) — point a platform cron at
   * `POST <basePath>/cron/run` there instead.
   */
  cronIntervalMs?: number | false;
}

export interface LatchApp<P> {
  runtime: Runtime<P>;
  handler: LatchHandler;
  models: ModelCatalog;
  /** The in-process cron driver, if one is running. */
  scheduler?: Scheduler;
  /** Stop the in-process cron (idempotent). */
  stop(): Promise<void>;
}

/** Env access without Node types: this package is Web-standard and may run where `process` is absent. */
const env = (name: string): string | undefined =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];

const SERVERLESS = !!(env("VERCEL") || env("AWS_LAMBDA_FUNCTION_NAME"));

export async function createLatchApp<P, RC = unknown>(cfg: LatchAppConfig<P, RC>): Promise<LatchApp<P>> {
  const models = cfg.models ?? (await loadModelCatalog());
  const agents = typeof cfg.agents === "function" ? cfg.agents(models) : cfg.agents;

  const runtime = createRuntime<P, RC>({
    storage: cfg.storage,
    context: cfg.context ?? defineContext<P, RC>({ build: () => ({}) as RC }),
    agents,
    // Resume-after-crash on by default: it costs a lease heartbeat per turn
    // and is what makes `cron()`'s sweep half do anything.
    durability: { enabled: true },
    cron: createCronerEvaluator(),
    ...providerDefaults<P, RC>(models, { principalKey: cfg.principalKey }),
    harnessTools: defaultHarnessTools(),
    ...cfg.runtime,
  });

  const handler = createLatchHandler<P>({
    runtime,
    resolveContext: cfg.resolveContext,
    // The system-wide cron route is unauthenticated — enabled only when a
    // secret is set (the handler 404s it otherwise).
    cronSecret: env("LATCH_CRON_SECRET"),
    ...cfg.handler,
  });

  let scheduler: Scheduler | undefined;
  const interval = cfg.cronIntervalMs ?? (SERVERLESS ? false : 30_000);
  if (interval !== false) {
    scheduler = createIntervalScheduler({
      intervalMs: interval,
      onTick: async () => {
        const r = await runtime.cron();
        for (const e of r.errors) console.error("[latch] cron phase failed:", e);
      },
      onError: (e) => console.error("[latch] cron failed:", e),
    });
    scheduler.start();
  }

  return {
    runtime,
    handler,
    models,
    scheduler,
    stop: async () => {
      await scheduler?.stop();
    },
  };
}
