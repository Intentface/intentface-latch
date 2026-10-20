import {
  createIntervalScheduler,
  createRuntime,
  type AgentFactory,
  type ContextInput,
  type Runtime,
  type RuntimeConfig,
  type Scheduler,
  type StorageAdapter,
} from "@intentface/latch-core";
import { loadModelCatalog, providerDefaults, type ModelCatalog } from "@intentface/latch-core/models";
import { defaultHarnessTools } from "@intentface/latch-core/harness";
import { createLatchHandler, principalResolverOf, type LatchHandler, type LatchHandlerConfig, type PrincipalResolver } from "./handler.js";
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
  /** Where conversations, runs and usage are stored, for example `createPostgresAdapter(db, { owner })`. */
  storage: StorageAdapter<P>;
  /**
   * Your agents, by name. Pass a function to get the model catalog, so an
   * agent can pick its model by id: `(models) => ({ assistant: defineAgent({
   * model: models.modelFor("claude-sonnet-4-6"), … }) })`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each agent declares its own params
  agents: Record<string, AgentFactory<P, any, any>> | ((models: ModelCatalog) => Record<string, AgentFactory<P, any, any>>);
  /** Your login: turns a request into the principal, or `null` for a `401`. Required (`resolveContext` is its old name). */
  resolvePrincipal?: PrincipalResolver<P>;
  /**
   * The old name of `resolvePrincipal`. Still works; set one or the other.
   *
   * @deprecated Renamed to `resolvePrincipal`.
   */
  resolveContext?: PrincipalResolver<P>;
  /** What your agents and tools can work with, built from who is asking on every turn: `async ({ principal }) => ({ … })`. @default `{}` */
  context?: ContextInput<P, RC>;
  /** A model catalog you already loaded. @default `loadModelCatalog()` */
  models?: ModelCatalog;
  /** A key per caller for prompt caching, so one person's cached prompt is never reused for another. Usually the same as the storage owner. */
  principalKey?: (principal: P) => string;
  /** Any other `createRuntime` option (limits, connections, schedules…), or a different value for one of the defaults. */
  runtime?: Partial<Omit<RuntimeConfig<P, RC>, "storage" | "agents" | "context">>;
  /** Any other `createLatchHandler` option, such as `basePath`, `connections` or `cronSecret`. */
  handler?: Partial<Omit<LatchHandlerConfig<P>, "runtime" | "resolvePrincipal" | "resolveContext">>;
  /**
   * How often to call `runtime.cron()` in this process, in ms, or `false` for
   * never. Off on serverless (when `VERCEL` or `AWS_LAMBDA_FUNCTION_NAME` is
   * set), where nothing runs between requests: call `runtime.cron()` from a
   * cron route instead.
   *
   * @default 30000 on a long-running server
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
    // Left out, the runtime builds an empty context.
    context: cfg.context,
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
    resolvePrincipal: principalResolverOf(cfg, "createLatchApp"),
    // The system-wide cron route is unauthenticated — enabled only when a
    // secret is set (the handler 404s it otherwise). CRON_SECRET is the one
    // Vercel sends to its crons, so on Vercel a cron in vercel.json pointing
    // at cron/run is all it takes.
    cronSecret: env("LATCH_CRON_SECRET") ?? env("CRON_SECRET"),
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
