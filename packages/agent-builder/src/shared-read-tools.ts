import { tool } from "ai";
import { z } from "zod";
import type { AgentBuilderStore } from "./store.js";

/**
 * Read-only discovery tools the builder shares with delegate agents (e.g. a
 * reviewer) — one implementation so the two can't drift. All are bound to
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
      description: "Get the full config of one of the user's agents (instructions, connections, exec capabilities).",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        // `getRecord` normalizes casing/spacing variants and honours an
        // `org:`/`user:` pin; personal wins over org on a bare name.
        const rec = await deps.store.getRecord(principal, name);
        if (!rec) return { error: `No editable agent named "${name}".` };
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
