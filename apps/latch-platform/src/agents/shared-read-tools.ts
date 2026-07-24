import { tool } from "ai";
import { z } from "zod";
import { normalizeAgentName } from "@/lib/agent-store";
import type { Principal } from "@/lib/session";
import type { getLatch } from "@/lib/latch";

/**
 * Read-only discovery tools shared by the Agent Builder and the Eval Author —
 * one implementation so the two agents can't drift. All are bound to the
 * chatting user's Principal; none mutate anything.
 */

type Latch = Awaited<ReturnType<typeof getLatch>>;

/** Personal owner key — same derivation as agent-store's ownerKey(p, "user"). */
export const personalOwner = (p: Principal): string =>
  [p.orgId, p.userId ?? ""].map(encodeURIComponent).join("/");

export function sharedReadTools(
  principal: Principal,
  {
    agentStore,
    allConnections,
    evalStore,
  }: Pick<Latch, "agentStore" | "allConnections" | "evalStore">,
): Record<string, unknown> {
  return {
    get_agent: tool({
      description: "Get the full config of one of the user's agents (instructions, connections, capabilities).",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        // Stored names are normalized (save_agent does it) — normalize the
        // lookup too so casing/spacing variants still resolve.
        const target = normalizeAgentName(name);
        const records = await agentStore.listRecords(principal);
        const rec = records.find((r) => r.name === target);
        if (!rec) return { error: `No editable agent named "${target}".` };
        return rec;
      },
    }),

    list_connection_tools: tool({
      description: "Enumerate the tools a set of connections exposes (to understand their capabilities).",
      inputSchema: z.object({ connections: z.array(z.string()) }),
      execute: async ({ connections: names }) => {
        if (names.length === 0) return [];
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
    }),

    list_eval_sets: tool({
      description: "The user's eval sets (optionally for one agent), with their full cases — read before editing a set.",
      inputSchema: z.object({ agentName: z.string().optional() }),
      execute: async ({ agentName }) => {
        const sets = await evalStore.listSets(
          personalOwner(principal),
          agentName ? normalizeAgentName(agentName) : undefined,
        );
        return sets.map((s) => ({ agentName: s.agentName, setName: s.name, cases: s.cases }));
      },
    }),
  };
}
