import { ToolLoopAgent, createAgentUIStreamResponse, createIdGenerator } from "ai";
import type { AppMessage } from "./message.js";
import { type Principal, scopeOf } from "./principal.js";
import type { ContextDefinition, SecretResolver } from "./context.js";
import type { AgentFactory } from "./agent.js";
import type { RunLease, RunRecord, StorageAdapter } from "./storage.js";

/**
 * The Runtime — composition root + operations facade.
 *
 * `createRuntime(config)` wires the chosen seams (storage, context, agent
 * registry) and exposes the operations. Routes/cron/CLI/tests all call the
 * runtime, never the seams directly. It's stateless and re-creatable (holds
 * adapters, no per-run state — that lives in the DB), so it's serverless-safe.
 *
 * T1: `handleChat` runs one turn with a `ToolLoopAgent` and persists via the
 * stock AI SDK stream helper — `onStepEnd` → runs/usage, `onFinish` → messages.
 */
/**
 * T2 durability (opt-in). When enabled, each turn claims a single-writer lease,
 * heartbeats it while streaming, and aborts if the lease is lost. A reaper
 * (`runtime.tick()`, driven by cron) reclaims runs whose owner died.
 */
export interface DurabilityConfig {
  enabled?: boolean;
  /** Lease lifetime in ms; a run is reapable once `now > leaseExpiresAt` (default 30s). */
  leaseTtlMs?: number;
  /** Heartbeat cadence in ms; must be comfortably < leaseTtlMs (default 10s). */
  heartbeatMs?: number;
  /** Stable owner id for this runtime instance (default: random per process). */
  instanceId?: string;
}

export interface RuntimeConfig<RuntimeContext = unknown> {
  storage: StorageAdapter;
  context: ContextDefinition<RuntimeContext>;
  /** The agent registry: name → factory (file-based or DB-driven upstream). */
  agents: Record<string, AgentFactory<RuntimeContext>>;
  secrets?: SecretResolver;
  durability?: DurabilityConfig;
}

export interface HandleChatInput {
  /** Which registered agent to run. */
  agent: string;
  /** Client-chosen chat id (create-or-continue). Omit to start a new chat. */
  chatId?: string;
  /** Resolved by the caller's ContextResolver (tenant isolation flows from this). */
  principal: Principal;
  /** The incoming user message. */
  message: AppMessage;
  /** Optional original request, passed to context.build. */
  request?: Request;
}

export interface Runtime {
  /** Run one turn; returns a streaming UIMessage `Response`. */
  handleChat(input: HandleChatInput): Promise<Response>;
  /**
   * Reaper tick (cron/Scheduler entry point): reclaim runs whose lease expired.
   * Returns the reaped runs. No-op-safe to call on every node.
   */
  tick(opts?: { now?: number; error?: string }): Promise<{ reaped: RunRecord[] }>;
}

/** Ids for assistant response messages — `msg_<random>`, matching storage ids. */
const generateMessageId = createIdGenerator({ prefix: "msg", separator: "_" });

const newInstanceId = createIdGenerator({ prefix: "inst", separator: "_" });

export function createRuntime<RC = unknown>(
  config: RuntimeConfig<RC>,
): Runtime {
  const { storage } = config;
  const dur = {
    enabled: config.durability?.enabled ?? false,
    leaseTtlMs: config.durability?.leaseTtlMs ?? 30_000,
    heartbeatMs: config.durability?.heartbeatMs ?? 10_000,
    instanceId: config.durability?.instanceId ?? newInstanceId(),
  };

  return {
    async tick(opts) {
      const reaped = await storage.reapExpiredRuns(opts?.now ?? Date.now(), {
        error: opts?.error,
      });
      return { reaped };
    },

    async handleChat({ agent: agentName, chatId, principal, message, request }) {
      const factory = config.agents[agentName];
      if (!factory) throw new Error(`Unknown agent: ${agentName}`);
      const scope = scopeOf(principal);

      // chat: scoped create-or-continue (cross-tenant ids resolve to "not found")
      let chat = chatId ? await storage.getChat(scope, chatId) : null;
      if (!chat) {
        chat = await storage.createChat({
          id: chatId, // use the provided id (create-or-continue); generated if omitted
          orgId: principal.orgId,
          userId: principal.userId,
          agent: agentName,
        });
      }
      const resolvedChatId = chat.id;

      // build typed context, then resolve the agent's config from it
      const runtimeCtx = await config.context.build({ principal, request });
      const cfg = await factory({ runtime: runtimeCtx, principal });
      const modelId =
        typeof cfg.model === "string"
          ? cfg.model
          : ((cfg.model as { modelId?: string }).modelId ?? "unknown");

      const prior = await storage.loadMessages(scope, resolvedChatId);

      // persist the user message up front (crash-safe), then open the run
      await storage.appendMessages(resolvedChatId, [message]);

      // T2: claim a single-writer lease; T1: an unleased run. `lease` (when set)
      // fences our writes so a reaped/reassigned run can't be clobbered by us.
      let run: RunRecord;
      let lease: RunLease | undefined;
      if (dur.enabled) {
        run = await storage.claimRun({
          chatId: resolvedChatId,
          agent: agentName,
          owner: dur.instanceId,
          ttlMs: dur.leaseTtlMs,
        });
        lease = { owner: dur.instanceId, fencingToken: run.fencingToken ?? 1 };
      } else {
        run = await storage.createRun({
          chatId: resolvedChatId,
          agent: agentName,
        });
      }

      // T2: heartbeat the lease while streaming; abort the run if we lose it
      // (reaped by another node, or the run was already closed).
      const abort = new AbortController();
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const stopHeartbeat = () => {
        if (heartbeat !== undefined) {
          clearInterval(heartbeat);
          heartbeat = undefined;
        }
      };
      if (dur.enabled) {
        heartbeat = setInterval(() => {
          void storage
            .heartbeatRun(run.id, dur.instanceId, dur.leaseTtlMs)
            .then((held) => {
              if (!held) {
                stopHeartbeat();
                abort.abort(new Error("lease lost"));
              }
            })
            .catch(() => {});
        }, dur.heartbeatMs);
        // Don't let the heartbeat alone keep a Node process alive.
        (heartbeat as { unref?: () => void }).unref?.();
      }

      const agent = new ToolLoopAgent({
        model: cfg.model,
        instructions: cfg.instructions,
        tools: cfg.tools,
      } as ConstructorParameters<typeof ToolLoopAgent>[0]);

      const uiMessages = [...prior, message];
      let inputTokens = 0;
      let outputTokens = 0;

      // Cast at the SDK generic boundary: our metadata/message types are looser
      // than the fully-inferred AI SDK generics, but the runtime behaviour is
      // exactly the stock stream helper (verified by the runtime smoke test).
      return createAgentUIStreamResponse({
        agent,
        uiMessages,
        originalMessages: uiMessages,
        abortSignal: dur.enabled ? abort.signal : undefined,
        // Persistence mode: without this the response message id is empty, so
        // every assistant turn upserts onto the same row. Give each a unique id.
        generateMessageId,
        messageMetadata: ({ part }: { part: { type: string } }) =>
          part.type === "start"
            ? { visibility: "user", model: modelId, createdAt: Date.now() }
            : undefined,
        onStepEnd: (step: {
          usage?: { inputTokens?: number; outputTokens?: number };
        }) => {
          inputTokens += step.usage?.inputTokens ?? 0;
          outputTokens += step.usage?.outputTokens ?? 0;
        },
        onFinish: async ({
          messages,
          isAborted,
        }: {
          messages: AppMessage[];
          isAborted?: boolean;
        }) => {
          stopHeartbeat();
          await storage.appendMessages(resolvedChatId, messages);
          // Aborted (lease lost / client gone): don't claim completion. The
          // guarded update no-ops if the run was already reaped+reassigned.
          if (isAborted) {
            await storage.updateRun(
              run.id,
              { status: "errored", error: "aborted", endedAt: Date.now() },
              lease,
            );
            return;
          }
          await storage.updateRun(
            run.id,
            {
              status: "completed",
              usageInputTokens: inputTokens,
              usageOutputTokens: outputTokens,
              endedAt: Date.now(),
            },
            lease,
          );
          await storage.recordUsage({
            orgId: principal.orgId,
            userId: principal.userId,
            runId: run.id,
            model: modelId,
            inputTokens,
            outputTokens,
            cost: 0,
          });
        },
        onError: (error: unknown) => {
          stopHeartbeat();
          return error instanceof Error ? error.message : "An error occurred.";
        },
      } as Parameters<typeof createAgentUIStreamResponse>[0]);
    },
  };
}
