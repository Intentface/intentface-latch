import type { AgentBuilderExtension } from "@intentface/latch-agent-builder";
import type { Principal } from "@/lib/session";

/**
 * The tool-authoring extension for the Agent Builder: author sandboxed JS/TS
 * tools (over `input` + an allowlisted `fetch`) and attach them to agents via
 * save_agent's `authoredTools`. Contributes the authoring tools (save_tool /
 * test_tool / list_tools / delete_tool), the BUILDING TOOLS prompt section,
 * and the save-time validation (existence + org-scope rules).
 */

const BUILDING_TOOLS_PROMPT = `BUILDING TOOLS (save_tool / test_tool / list_tools / delete_tool):
When an agent needs an external API or any real computation, AUTHOR A TOOL instead of asking the model to do it in its head. Attach authored tools to an agent via save_agent's authoredTools (names from list_tools). Author + test the tool(s) an agent needs during the discovery step, before proposing the agent.

A tool is a JS or TypeScript program (TS types are allowed — they're stripped automatically; no type-checking). It runs in a locked-down sandbox whose ONLY globals are:
- \`input\` — the call arguments (shaped by the tool's inputSchema).
- \`fetch(url, opts?)\` — HTTP. Returns \`{ ok, status, statusText, headers, text, json }\` where \`json\` is the parsed body when the response is JSON (else null) and \`text\` is the raw string. It throws if the host isn't allowed. Example: \`const r = await fetch(url); const data = r.json;\`
There is NOTHING else — no console, no require/import, no process/fs/timers. The program MUST end with \`return <JSON-serializable value>\`.
\`fetch\` is restricted to the tool's \`allowedHosts\`: list EVERY hostname it calls (e.g. ["api.open-meteo.com"]); private/loopback hosts are always blocked; empty allowedHosts = no network.
Keep results compact: do the filtering/aggregation IN CODE and return only what the model needs (results over ~64KB are truncated; a run times out at ~15s).

Design principle: keep ALL fetching, math, unit conversion, ranking, and safety rules IN THE TOOL'S CODE; the agent that uses it only phrases the result and makes judgment calls. The tool returns clean, already-computed data (not raw API JSON) so the model never has to calculate.

SCOPE: a tool is personal (default) or org-shared (scope:"org"). Match it to the agent you're building — an ORG agent can ONLY attach org-scoped tools (a personal tool wouldn't resolve for other members), so author its tools with scope:"org". A personal agent may use personal or org tools.

Flow: write the program → call test_tool (pass sample \`input\` and the same allowedHosts) to confirm it runs and its fetches resolve — a compile error, thrown error, or fetch failure comes back in the result, so fix and re-test until correct → save_tool with a clear name, a description covering its inputs/output, an input JSON Schema, and allowedHosts. Then attach it to an agent via save_agent's authoredTools. Saved tools are visible and editable by the user on the Tools page. test_agent NOTE: authored tools are not approval-gated, so they execute for real in tests — including any fetch side effects (e.g. a POST).`;

/** The live services, resolved lazily per call (avoids a static import cycle). */
async function services() {
  const { getLatch } = await import("@/lib/latch");
  return getLatch();
}

export function toolAuthoringExtension(): AgentBuilderExtension<Principal> {
  return {
    name: "tool-authoring",
    handlesAuthoredTools: true,
    promptSections: [BUILDING_TOOLS_PROMPT],
    toolApproval: {
      // save_tool commits (it may end up attached to agents); test_tool (no
      // persist) + reads stay un-gated so authoring iterates freely.
      save_tool: "user-approval",
      delete_tool: "user-approval",
    },
    tools: async (principal) => {
      const { authoredTools } = await services();
      return authoredTools.authoringTools(principal);
    },
    validateSave: async (principal, input) => {
      if (!input.authoredTools?.length) return undefined;
      const { authoredTools } = await services();
      const owned = await authoredTools.listFor(principal);
      const ownedNames = new Set(owned.map((t) => t.name));
      const bad = input.authoredTools.filter((n) => !ownedNames.has(n));
      if (bad.length) {
        return `Unknown authored tool(s): ${bad.join(", ")}. Use list_tools (author them first).`;
      }
      // An org agent can only use org-scoped tools (else they're missing for
      // other members). Tell the builder to re-save them with scope:"org".
      if (input.scope === "org") {
        const orgNames = new Set(owned.filter((t) => t.scope === "org").map((t) => t.name));
        const personal = input.authoredTools.filter((n) => !orgNames.has(n));
        if (personal.length) {
          return `Org agents can only use org-scoped tools. Re-save these with scope:"org": ${personal.join(", ")}.`;
        }
      }
      return undefined;
    },
  };
}
