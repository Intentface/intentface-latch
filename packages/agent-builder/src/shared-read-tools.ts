import { tool } from "ai";
import { z } from "zod";
import { normalizeAgentName } from "./store";
import type { AgentBuilderStore } from "./store";

/**
 * Read-only discovery tools the builder shares with delegate agents (e.g. an
 * eval author) — one implementation so the two can't drift. All are bound to
 * the chatting user's principal; none mutate anything.
 */

export interface SharedReadDeps<P> {
  store: AgentBuilderStore<P>;
  /** Enumerate the tools a set of connections exposes, for this caller. */
  connectionTools: (principal: P, names: string[]) => Promise<{ name: string; description: string }[]>;
}

export function sharedReadTools<P>(principal: P, deps: SharedReadDeps<P>): Record<string, unknown> {
  return {
    get_agent: tool({
      description: "Get the full config of one of the user's agents (instructions, connections, capabilities).",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        // Stored names are normalized (save_agent does it) — normalize the
        // lookup too so casing/spacing variants still resolve.
        const target = normalizeAgentName(name);
        const records = await deps.store.listRecords(principal);
        const rec = records.find((r) => r.name === target);
        if (!rec) return { error: `No editable agent named "${target}".` };
        return rec;
      },
    }),

    list_connection_tools: tool({
      description: "Enumerate the tools a set of connections exposes (to understand their capabilities).",
      inputSchema: z.object({ connections: z.array(z.string()) }),
      execute: async ({ connections }) => {
        if (connections.length === 0) return [];
        return deps.connectionTools(principal, connections);
      },
    }),
  };
}
