import {
  ToolLoopAgent,
  createIdGenerator,
  createUIMessageStream,
  createUIMessageStreamResponse,
  toUIMessageStream,
} from "ai";
import type { AppMessage } from "./message.js";
import { type Principal, scopeOf } from "./principal.js";
import type { ContextDefinition, SecretResolver } from "./context.js";
import type { AgentConfig, AgentFactory, OpenToolSet } from "./agent.js";
import { toClientMessages, toModelMessages } from "./projections.js";
import { computeCost, type Pricing } from "./pricing.js";
import type {
  ChatRecord,
  RunLease,
  RunRecord,
  RunStatus,
  StorageAdapter,
} from "./storage.js";

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
  /** Optional cost calculation. Without it, recorded cost is 0. */
  pricing?: Pricing;
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
   * Client-projected conversation history (`toClientMessages`): the stored
   * messages with `internal`/`redacted` ones filtered out. For rendering past
   * turns on load.
   */
  loadHistory(input: {
    chatId: string;
    principal: Principal;
  }): Promise<AppMessage[]>;
  /** The tenant's chats, most-recent first (for a chat list / sidebar). */
  listChats(input: {
    principal: Principal;
    limit?: number;
  }): Promise<ChatRecord[]>;
  /** The tenant's runs, most-recent first (status, usage, cost — for an ops view). */
  listRuns(input: {
    principal: Principal;
    limit?: number;
  }): Promise<RunRecord[]>;
  /**
   * Reaper tick (cron/Scheduler entry point): reclaim runs whose lease expired.
   * Returns the reaped runs. No-op-safe to call on every node.
   */
  tick(opts?: { now?: number; error?: string }): Promise<{ reaped: RunRecord[] }>;
  /**
   * Resume an interrupted run (requires durability). Re-claims it exactly-once,
   * re-runs the turn from persisted history, and completes it server-side.
   * Returns the run's final state, or null if it wasn't resumable (already
   * completed, or claimed by another node).
   */
  resume(runId: string): Promise<RunOutcome | null>;
  /**
   * Reaper + auto-resume in one call — the Scheduler/cron entry point. Reaps
   * lease-expired runs, then resumes each whose attempt count is still under
   * `maxAttempts` (default 5; the cap stops poison runs from looping forever).
   * Safe to fire on every node: reap and reclaim are atomic, so each run is
   * handled exactly once.
   */
  sweep(opts?: {
    now?: number;
    maxAttempts?: number;
    error?: string;
  }): Promise<{ reaped: RunRecord[]; resumed: RunOutcome[] }>;
  /**
   * Apply HITL tool-approval decisions and continue the turn. Records each
   * decision onto the persisted assistant message (approval-requested →
   * approval-responded), then re-runs the agent from history: approved tools
   * execute, denied ones are skipped. Returns the continuation's streaming
   * Response. No suspension machinery — approvals round-trip as message state.
   */
  applyApproval(input: {
    chatId: string;
    principal: Principal;
    decisions: ApprovalDecision[];
    request?: Request;
  }): Promise<Response>;
}

/** A user's decision on one pending tool-approval request. */
export interface ApprovalDecision {
  approvalId: string;
  approved: boolean;
  reason?: string;
}

/** The terminal state of a resumed run. */
export interface RunOutcome {
  runId: string;
  status: RunStatus;
  attempt: number | null;
}

/**
 * The minimal `UIMessageStreamWriter` surface we use: `merge` to fold in the
 * model's stream, and `write` for custom data parts (exposed to tools/context).
 */
export interface TurnWriter {
  write(part: unknown): void;
  merge(stream: ReadableStream<unknown>): void;
}

/** Ids for assistant response messages — `msg_<random>`, matching storage ids. */
const generateMessageId = createIdGenerator({ prefix: "msg", separator: "_" });

const newInstanceId = createIdGenerator({ prefix: "inst", separator: "_" });

/** A tool/dynamic-tool UI part, narrowed to the approval fields we touch. */
type ApprovalPart = {
  type: string;
  state?: string;
  approval?: { id: string; approved?: boolean; reason?: string };
};

/** The concatenated text of a message's text parts (for a chat title). */
function firstText(message: AppMessage): string | undefined {
  const text = (message.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();
  return text.length > 0 ? text : undefined;
}

/** True if any message has a tool part still awaiting an approval decision. */
function hasPendingApproval(messages: AppMessage[]): boolean {
  for (const m of messages) {
    for (const p of (m.parts ?? []) as ApprovalPart[]) {
      if (p.state === "approval-requested" && p.approval?.approved === undefined) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Record decisions onto matching `approval-requested` parts (→ `approval-responded`).
 * Mutates in place and returns the messages that changed (to re-persist).
 */
function applyDecisions(
  messages: AppMessage[],
  decisions: ApprovalDecision[],
): AppMessage[] {
  const byId = new Map(decisions.map((d) => [d.approvalId, d]));
  const changed: AppMessage[] = [];
  for (const m of messages) {
    let touched = false;
    for (const p of (m.parts ?? []) as ApprovalPart[]) {
      if (p.state === "approval-requested" && p.approval && byId.has(p.approval.id)) {
        const d = byId.get(p.approval.id)!;
        p.state = "approval-responded";
        p.approval = { ...p.approval, approved: d.approved, reason: d.reason };
        touched = true;
      }
    }
    if (touched) changed.push(m);
  }
  return changed;
}

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

  /** Resolve an agent's per-request config + a display model id. */
  async function resolveAgentConfig(
    agentName: string,
    principal: Principal,
    request?: Request,
  ): Promise<{ cfg: AgentConfig; modelId: string; runtimeCtx: RC }> {
    const factory = config.agents[agentName];
    if (!factory) throw new Error(`Unknown agent: ${agentName}`);
    const runtimeCtx = await config.context.build({ principal, request });
    const cfg = await factory({ runtime: runtimeCtx, principal });
    const modelId =
      typeof cfg.model === "string"
        ? cfg.model
        : ((cfg.model as { modelId?: string }).modelId ?? "unknown");
    return { cfg, modelId, runtimeCtx };
  }

  /**
   * Build (and start) one turn's stream — shared by a fresh chat turn and a
   * resume. With durability on, it heartbeats the lease and aborts if it's
   * lost; onFinish writes are fenced by `lease`. The caller decides whether to
   * hand the stream to a client (handleChat) or drive it to completion
   * server-side (resume).
   */
  async function buildTurn(args: {
    resolvedChatId: string;
    principal: Principal;
    modelId: string;
    cfg: AgentConfig;
    run: RunRecord;
    lease: RunLease | undefined;
    uiMessages: AppMessage[];
    runtimeCtx: RC;
  }): Promise<Response> {
    const { resolvedChatId, principal, modelId, cfg, run, lease, uiMessages, runtimeCtx } =
      args;

    const abort = new AbortController();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stopHeartbeat = () => {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    };
    if (dur.enabled && lease) {
      heartbeat = setInterval(() => {
        void storage
          .heartbeatRun(run.id, lease.owner, dur.leaseTtlMs)
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

    // Open dynamic tool sources (e.g. MCP) for this tenant, then merge their
    // tools with the static ones. They're closed when the turn ends. If opening
    // one fails, close any already opened so we don't leak connections.
    const opened: OpenToolSet[] = [];
    try {
      for (const source of cfg.toolSources ?? []) {
        opened.push(await source.open(scopeOf(principal)));
      }
    } catch (error) {
      await Promise.all(opened.map((o) => o.close().catch(() => {})));
      stopHeartbeat();
      throw error;
    }
    const closeSources = () =>
      Promise.all(opened.map((o) => o.close().catch(() => {}))).then(
        () => undefined,
      );
    const tools = Object.assign({}, cfg.tools, ...opened.map((o) => o.tools));

    const agent = new ToolLoopAgent({
      model: cfg.model,
      instructions: cfg.instructions,
      tools,
      toolApproval: cfg.toolApproval,
    } as ConstructorParameters<typeof ToolLoopAgent>[0]);

    let inputTokens = 0;
    let outputTokens = 0;

    // Lower-level composition (vs `createAgentUIStreamResponse`) so we get the
    // UI-stream `onStepEnd` (per-step persistence) and the `writer`. The model
    // call runs INSIDE `execute` so the writer is live during the turn — code
    // here can write data parts (e.g. a compaction marker) before the model's
    // output, and tools can write via `toolsContext`.
    const stream = createUIMessageStream({
      originalMessages: uiMessages,
      // Persistence mode: one stable assistant-message id per turn (else every
      // turn would upsert onto the same row — see the dup-id regression test).
      generateId: generateMessageId,
      execute: async ({ writer }: { writer: TurnWriter }) => {
        // (in-turn writer writes — e.g. a "compacting…" / compaction marker —
        //  would go here, before the model output is merged in)
        // Model projection: drops `sendToModel:false` messages (and data-* parts).
        const modelMessages = await toModelMessages(uiMessages, { tools });
        const result = await agent.stream({
          prompt: modelMessages,
          abortSignal: dur.enabled ? abort.signal : undefined,
          // Shared context for hooks / prepareStep / approval policies.
          runtimeContext: runtimeCtx,
          // `toolsContext` is keyed BY TOOL NAME (the SDK does
          // `toolsContext[toolName]`), so point every tool at the same context:
          // the project's runtime context + who it's for + the run + the writer.
          // A tool reads it as `options.context`.
          toolsContext: Object.fromEntries(
            Object.keys(tools).map((name) => [
              name,
              {
                ...(runtimeCtx as Record<string, unknown>),
                principal,
                run: { id: run.id, chatId: resolvedChatId },
                writer,
              },
            ]),
          ),
          // generate-text step callback: accumulate usage across steps.
          onStepEnd: (step: {
            usage?: { inputTokens?: number; outputTokens?: number };
          }) => {
            inputTokens += step.usage?.inputTokens ?? 0;
            outputTokens += step.usage?.outputTokens ?? 0;
          },
        } as unknown as Parameters<typeof agent.stream>[0]);
        // Fold the model's own output into the stream.
        writer.merge(
          toUIMessageStream({
            stream: result.stream,
            messageMetadata: ({ part }: { part: { type: string } }) =>
              part.type === "start"
                ? { visibility: "user", model: modelId, createdAt: Date.now() }
                : undefined,
          } as Parameters<typeof toUIMessageStream>[0]) as ReadableStream<unknown>,
        );
      },
      // UI-stream per-step hook: checkpoint the in-progress assistant message
      // (with any completed tool results) so a crash mid-turn doesn't repeat
      // them on resume. Durable turns only — keeps T1 write counts unchanged.
      onStepEnd: dur.enabled
        ? ({ responseMessage }: { responseMessage: AppMessage }) => {
            void storage
              .appendMessages(resolvedChatId, [responseMessage])
              .catch(() => {});
          }
        : undefined,
      onFinish: async ({
        messages,
        isAborted,
      }: {
        messages: AppMessage[];
        isAborted?: boolean;
      }) => {
        stopHeartbeat();
        await closeSources();
        // Cost for this turn (0 if no pricing configured). Stamp usage + cost
        // onto the assistant message — the message is complete; this is metadata.
        const cost = computeCost(
          config.pricing?.(modelId),
          inputTokens,
          outputTokens,
        );
        const last = messages[messages.length - 1];
        if (last?.role === "assistant") {
          last.metadata = {
            ...last.metadata,
            usage: { inputTokens, outputTokens },
            cost,
          };
        }
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
        // A gated tool ended the turn awaiting a decision — pause, don't
        // complete. The decision arrives via applyApproval (message state).
        const paused = hasPendingApproval(messages);
        await storage.updateRun(
          run.id,
          {
            status: paused ? "awaiting_input" : "completed",
            usageInputTokens: inputTokens,
            usageOutputTokens: outputTokens,
            costTotal: cost,
            endedAt: paused ? undefined : Date.now(),
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
          cost,
        });
      },
      onError: (error: unknown) => {
        stopHeartbeat();
        void closeSources();
        return error instanceof Error ? error.message : "An error occurred.";
      },
    } as Parameters<typeof createUIMessageStream>[0]);

    return createUIMessageStreamResponse({ stream });
  }

  async function reapTick(opts?: { now?: number; error?: string }) {
    const reaped = await storage.reapExpiredRuns(opts?.now ?? Date.now(), {
      error: opts?.error,
    });
    return { reaped };
  }

  /** Open a run for a turn: durable → leased claim; T1 → an unleased run. */
  async function openRun(
    chatId: string,
    agentName: string,
  ): Promise<{ run: RunRecord; lease: RunLease | undefined }> {
    if (dur.enabled) {
      const run = await storage.claimRun({
        chatId,
        agent: agentName,
        owner: dur.instanceId,
        ttlMs: dur.leaseTtlMs,
      });
      return { run, lease: { owner: dur.instanceId, fencingToken: run.fencingToken ?? 1 } };
    }
    return { run: await storage.createRun({ chatId, agent: agentName }), lease: undefined };
  }

  async function handleChat({
    agent: agentName,
    chatId,
    principal,
    message,
    request,
  }: HandleChatInput): Promise<Response> {
    const scope = scopeOf(principal);

      // chat: scoped create-or-continue (cross-tenant ids resolve to "not found")
      let chat = chatId ? await storage.getChat(scope, chatId) : null;
      if (!chat) {
        chat = await storage.createChat({
          id: chatId, // use the provided id (create-or-continue); generated if omitted
          orgId: principal.orgId,
          userId: principal.userId,
          agent: agentName,
          // Title from the first user message — for the chat list.
          title: firstText(message)?.slice(0, 80),
        });
      }
      const resolvedChatId = chat.id;

      const { cfg, modelId, runtimeCtx } = await resolveAgentConfig(
        agentName,
        principal,
        request,
      );

    const prior = await storage.loadMessages(scope, resolvedChatId);

    // persist the user message up front (crash-safe), then open the run
    await storage.appendMessages(resolvedChatId, [message]);
    const { run, lease } = await openRun(resolvedChatId, agentName);

    return buildTurn({
      resolvedChatId,
      principal,
      modelId,
      cfg,
      run,
      lease,
      uiMessages: [...prior, message],
      runtimeCtx,
    });
  }

  async function resumeRun(runId: string): Promise<RunOutcome | null> {
    if (!dur.enabled) throw new Error("resume requires durability.enabled");

    // Exactly-once re-claim: only one node wins; a concurrent resumer / an
    // already-completed run yields null.
    const run = await storage.reclaimRun(runId, dur.instanceId, dur.leaseTtlMs);
    if (!run) return null;

    // System op: recover the tenant from the chat (no Principal on the wire).
    const chat = await storage.getChatById(run.chatId);
    if (!chat) return null;
    const principal: Principal = { orgId: chat.orgId, userId: chat.userId };
    const scope = scopeOf(principal);

    const { cfg, modelId, runtimeCtx } = await resolveAgentConfig(run.agent, principal);
    const uiMessages = await storage.loadMessages(scope, run.chatId);
    const lease: RunLease = {
      owner: dur.instanceId,
      fencingToken: run.fencingToken ?? 1,
    };

    // Re-run from persisted history and drive to completion server-side
    // (there's no client to consume the stream).
    const res = await buildTurn({
      resolvedChatId: run.chatId,
      principal,
      modelId,
      cfg,
      run,
      lease,
      uiMessages,
      runtimeCtx,
    });
    await res.text();

    const final = await storage.getRun(runId);
    return {
      runId,
      status: final?.status ?? "errored",
      attempt: final?.attempt ?? run.attempt ?? null,
    };
  }

  async function sweep(opts?: {
    now?: number;
    maxAttempts?: number;
    error?: string;
  }): Promise<{ reaped: RunRecord[]; resumed: RunOutcome[] }> {
    if (!dur.enabled) throw new Error("sweep requires durability.enabled");
    const maxAttempts = opts?.maxAttempts ?? 5;
    const { reaped } = await reapTick({ now: opts?.now, error: opts?.error });
    const resumed: RunOutcome[] = [];
    for (const run of reaped) {
      // Give up on poison runs that keep dying — don't loop forever.
      if ((run.attempt ?? 1) >= maxAttempts) continue;
      const outcome = await resumeRun(run.id);
      if (outcome) resumed.push(outcome);
    }
    return { reaped, resumed };
  }

  async function applyApproval({
    chatId,
    principal,
    decisions,
    request,
  }: {
    chatId: string;
    principal: Principal;
    decisions: ApprovalDecision[];
    request?: Request;
  }): Promise<Response> {
    const scope = scopeOf(principal);
    const chat = await storage.getChat(scope, chatId);
    if (!chat) throw new Error(`Unknown chat: ${chatId}`);

    // Merge the decisions onto the persisted assistant message, then re-persist
    // only what changed. The agent continues from this updated history.
    const messages = await storage.loadMessages(scope, chatId);
    const changed = applyDecisions(messages, decisions);
    if (changed.length > 0) await storage.appendMessages(chatId, changed);

    const { cfg, modelId, runtimeCtx } = await resolveAgentConfig(chat.agent, principal, request);
    const { run, lease } = await openRun(chatId, chat.agent);

    return buildTurn({
      resolvedChatId: chatId,
      principal,
      modelId,
      cfg,
      run,
      lease,
      uiMessages: messages,
      runtimeCtx,
    });
  }

  async function loadHistory({
    chatId,
    principal,
  }: {
    chatId: string;
    principal: Principal;
  }): Promise<AppMessage[]> {
    const messages = await storage.loadMessages(scopeOf(principal), chatId);
    return toClientMessages(messages);
  }

  async function listChats({
    principal,
    limit,
  }: {
    principal: Principal;
    limit?: number;
  }): Promise<ChatRecord[]> {
    return storage.listChats(scopeOf(principal), { limit });
  }

  async function listRuns({
    principal,
    limit,
  }: {
    principal: Principal;
    limit?: number;
  }): Promise<RunRecord[]> {
    return storage.listRuns(scopeOf(principal), { limit });
  }

  return {
    tick: reapTick,
    handleChat,
    loadHistory,
    listChats,
    listRuns,
    resume: resumeRun,
    sweep,
    applyApproval,
  };
}
