import { tool } from "ai";
import { z } from "zod";
import { sharedReadTools as packageSharedReadTools } from "@intentface/latch-agent-builder";
import { normalizeAgentName } from "@/lib/agent-store";
import type { Principal } from "@/lib/session";
import type { getLatch } from "@/lib/latch";

/**
 * Read-only discovery tools shared by the Agent Builder and the Eval Author —
 * one implementation so the two agents can't drift. `get_agent` and
 * `list_connection_tools` come from the framework package; `list_eval_sets` is
 * the platform's eval feature. All are bound to the chatting user's Principal;
 * none mutate anything.
 */

type Latch = Awaited<ReturnType<typeof getLatch>>;

/** Personal owner key — same derivation as agent-store's ownerKey(p, "user"). */
export const personalOwner = (p: Principal): string =>
  [p.orgId, p.userId ?? ""].map(encodeURIComponent).join("/");

/** Enumerate the tools a set of connections exposes, for this caller (opens them live). */
export async function listConnectionTools(
  allConnections: Latch["allConnections"],
  principal: Principal,
  names: string[],
): Promise<{ name: string; description: string }[]> {
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
}

/** The platform's eval-set reader (shared by the builder's evals extension and the eval author). */
export function evalSetTools(principal: Principal, evalStore: Latch["evalStore"]): Record<string, unknown> {
  return {
    list_eval_sets: tool({
      description:
        "The user's eval sets (optionally for one agent), with their full cases — read before editing a set.",
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

export function sharedReadTools(
  principal: Principal,
  { agentStore, allConnections, evalStore }: Pick<Latch, "agentStore" | "allConnections" | "evalStore">,
): Record<string, unknown> {
  return {
    ...packageSharedReadTools(principal, {
      store: agentStore,
      connectionTools: (p, names) => listConnectionTools(allConnections, p, names),
    }),
    ...evalSetTools(principal, evalStore),
  };
}
