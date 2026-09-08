import { anthropic } from "@ai-sdk/anthropic";
import { createAgentBuilder } from "@intentface/latch-agent-builder";
import type { AgentBuilderDeps } from "@intentface/latch-agent-builder";
import type { Principal } from "@/lib/session";
import { renderFetchConfigured } from "@/lib/render-fetch";
import { listConnectionTools } from "./shared-read-tools";
import { connectionsExtension } from "./builder-extensions/connections";
import { memoryExtension } from "./builder-extensions/memory";
import { schedulesExtension } from "./builder-extensions/schedules";
import { evalsExtension } from "./builder-extensions/evals";
import { toolAuthoringExtension } from "./builder-extensions/tool-authoring";

/**
 * The platform's Agent Builder = the framework's meta-agent
 * (`@intentface/latch-agent-builder`: agent CRUD, discovery, test_agent) plus
 * the platform's feature sets as extensions: connections + secrets, memory
 * schemas, delivery-aware schedules, online evals, tool authoring. The host
 * services arrive lazily through `deps` (the composition root imports this
 * module, so a static import of `@/lib/latch` would be a cycle).
 */

/** Built-in (code-declared) agents — names the builder must not try to overwrite. */
export const RESERVED_AGENT_NAMES = ["assistant", "weekly", "agent-builder", "eval-author"];

const deps = async (_principal: Principal): Promise<AgentBuilderDeps<Principal>> => {
  const { getLatch } = await import("@/lib/latch");
  const { runtime, agentStore, allConnections, connections, connectionStore, dynamic, models } = await getLatch();
  return {
    runtime,
    store: agentStore,
    models,
    // Code-declared + the caller's UI-added connections, with authorization
    // state for the dynamic ones (code connections report authorized).
    listConnections: async (p) => {
      const stored = await connectionStore.list(p);
      const status = new Map((await dynamic.status(p)).map((s) => [s.name, s]));
      const names = Array.from(new Set([...connections.names, ...stored.map((c) => c.name)]));
      return names.map((name) => ({
        name,
        kind: stored.find((c) => c.name === name)?.kind ?? "mcp",
        authorized: status.get(name)?.authorized ?? true,
      }));
    },
    connectionTools: (p, names) => listConnectionTools(allConnections, p, names),
  };
};

export const agentBuilder = createAgentBuilder<Principal, { orgId: string }>({
  model: anthropic("claude-sonnet-4-6"),
  deps,
  reservedNames: RESERVED_AGENT_NAMES,
  // The schedules extension supplies delivery-aware schedule tools; the
  // package's plain ones would be a confusing duplicate.
  scheduling: false,
  capabilities: {
    // Only offer render tools where the render service is configured —
    // otherwise `exec.renderTools` would persist as a silent no-op.
    renderTools: renderFetchConfigured(),
    defaultTools: {
      description: "web_fetch, askUser, and self-scheduling (create/list/cancel_schedule)",
    },
    // Opt-in capabilities this host actually composes.
    memory: { description: "persistent cross-session memory — see MEMORY & SCHEMAS" },
    extensions: { description: "the platform runs callscript + Liquid; slash commands show up in the chat composer's / menu" },
  },
  extensions: [
    connectionsExtension,
    memoryExtension,
    schedulesExtension,
    evalsExtension,
    toolAuthoringExtension,
  ],
  meta: {
    title: "Agent Builder",
    description: "Designs, creates, and updates your agents from a conversation.",
  },
});
