import { anthropic } from "@ai-sdk/anthropic";
import { createAgentBuilder } from "@intentface/latch-agent-builder";
import type { AgentBuilderDeps } from "@intentface/latch-agent-builder";
import type { Principal } from "@/lib/session";
import { evalsExtension } from "./extensions/evals";
import { toolAuthoringExtension } from "./extensions/tool-authoring";

/**
 * The Agent Builder, assembled from `@intentface/latch-agent-builder` with
 * this platform's full extension set: evals (regression suites + the
 * eval-author delegate) and tool authoring (sandboxed JS tools).
 *
 * Mutations (save/delete/save_tool/save_eval_set/run_evals) are gated with
 * `user-approval`, so the user sees and confirms before anything persists.
 */

/**
 * Host services for the builder, bound per turn (lazy import avoids a static
 * import cycle). Exported for the eval-author, which shares the same read
 * tools (get_agent / list_connection_tools) so the two can't drift.
 */
export async function builderDeps(): Promise<AgentBuilderDeps<Principal>> {
  const { getLatch } = await import("@/lib/latch");
  const { runtime, agentStore, allConnections, connections, connectionStore, dynamic, models } =
    await getLatch();
  return {
    runtime,
    store: agentStore,
    models: models.map((m) => ({ id: m.id, label: m.label, provider: m.provider, reasoning: !!m.reasoning })),
    listConnections: async (principal) => {
      const stored = await connectionStore.list(principal);
      const status = new Map((await dynamic.status(principal)).map((s) => [s.name, s]));
      const names = Array.from(new Set([...connections.names, ...stored.map((c) => c.name)]));
      return names.map((name) => ({
        name,
        kind: stored.find((c) => c.name === name)?.kind ?? "mcp",
        authorized: status.get(name)?.authorized ?? true,
      }));
    },
    connectionTools: async (principal, names) => {
      const opened = await allConnections.hostFor(names).open(principal);
      try {
        return Object.keys(opened.tools)
          .filter((k) => !k.startsWith("connect_"))
          .map((toolName) => ({
            name: toolName,
            description:
              (opened.tools[toolName] as { description?: string } | undefined)?.description ?? "",
          }));
      } finally {
        await opened.close();
      }
    },
  };
}

export const agentBuilder = createAgentBuilder<Principal, { orgId: string }>({
  model: anthropic("claude-sonnet-4-6"),
  deps: () => builderDeps(),
  /** Built-in (code-declared) agents — names the builder must not overwrite. */
  reservedNames: ["assistant", "weekly", "agent-builder"],
  extensions: [toolAuthoringExtension(), evalsExtension()],
});
