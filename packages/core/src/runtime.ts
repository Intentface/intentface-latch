import { ToolLoopAgent, createAgentUIStreamResponse } from "ai";
import type { AppMessage } from "./message.js";
import { type Principal, scopeOf } from "./principal.js";
import type { ContextDefinition, SecretResolver } from "./context.js";
import type { AgentFactory } from "./agent.js";
import type { StorageAdapter } from "./storage.js";

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
export interface RuntimeConfig<RuntimeContext = unknown> {
  storage: StorageAdapter;
  context: ContextDefinition<RuntimeContext>;
  /** The agent registry: name → factory (file-based or DB-driven upstream). */
  agents: Record<string, AgentFactory<RuntimeContext>>;
  secrets?: SecretResolver;
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
}

export function createRuntime<RC = unknown>(
  config: RuntimeConfig<RC>,
): Runtime {
  const { storage } = config;

  return {
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
      const run = await storage.createRun({
        chatId: resolvedChatId,
        agent: agentName,
      });

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
        onFinish: async ({ messages }: { messages: AppMessage[] }) => {
          await storage.appendMessages(resolvedChatId, messages);
          await storage.updateRun(run.id, {
            status: "completed",
            usageInputTokens: inputTokens,
            usageOutputTokens: outputTokens,
            endedAt: Date.now(),
          });
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
      } as Parameters<typeof createAgentUIStreamResponse>[0]);
    },
  };
}
