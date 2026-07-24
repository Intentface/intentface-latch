import { anthropic } from "@ai-sdk/anthropic";
import { tool } from "ai";
import { z } from "zod";
import { defineAgent } from "@intentface/latch-core";
import type { Principal } from "@/lib/session";
import {  normalizeAgentName } from "@/lib/agent-store";
import type {AgentRecord, AttachedEval} from "@/lib/agent-store";
import { validateRubrics } from "@/lib/observability/rubrics";
import { sharedReadTools } from "./shared-read-tools";

/**
 * The Agent Builder — a meta-agent that designs, creates, and updates other
 * agents on behalf of the user it's talking to. Its tools are host functions
 * bound to that user's Principal (via `toolSources.open`), so everything it
 * writes lands at the user's own scope through the same `agentStore` the editor
 * uses. Reads connections/models/history to make grounded proposals.
 *
 * Mutations (save/delete) are gated with `user-approval`, so the user sees and
 * confirms the exact spec before it persists.
 */

/** Built-in (code-declared) agents — names the builder must not try to overwrite. */
const RESERVED_NAMES = new Set(["assistant", "weekly", "agent-builder", "eval-author"]);

const SCOPE = z.enum(["user", "org"]);

const CAPABILITIES = z
  .object({
    codeMode: z.boolean().optional().describe("Agent writes/runs a JS program over its tools (multi-step orchestration)."),
    sandbox: z.boolean().optional().describe("Per-session workspace + file/shell tools (bash, read_file, …)."),
    providerWebTools: z.boolean().optional().describe("Native provider web search/fetch (Anthropic/OpenAI)."),
    defaultTools: z.boolean().optional().describe("App harness tools: web_fetch + askUser."),
  })
  .optional();

const SAVE_INPUT = z.object({
  name: z.string().describe("Unique kebab-case id. Reusing an existing name UPDATES that agent."),
  title: z.string().optional().describe("Short human label for the picker."),
  description: z.string().optional().describe("One line on what the agent does."),
  modelId: z.string().describe("Must be an id returned by list_models."),
  instructions: z.string().describe("The system prompt — the heart of the agent. Be specific."),
  connections: z.array(z.string()).optional().describe("Connection names from list_connections."),
  capabilities: CAPABILITIES,
  authoredTools: z
    .array(z.string())
    .optional()
    .describe("Names of your authored tools (from list_tools) to attach to this agent."),
  subagents: z.array(z.string()).optional().describe("Names of agents this one may delegate to."),
  maxSteps: z.union([z.number(), z.literal("unlimited")]).optional(),
  effort: z
    .enum(["minimal", "low", "medium", "high"])
    .optional()
    .describe("Reasoning/thinking effort. Only set for a model where list_models shows reasoning=true."),
  scope: SCOPE.describe("'user' (personal) or 'org' (shared). Ask the user — never guess."),
});

/** One online-eval rubric to attach to an agent (judged on every live run). */
const ATTACHED_EVAL_INPUT = z.object({
  name: z
    .string()
    .describe("Kebab-case id — becomes the Langfuse score name (e.g. 'stays-on-topic')."),
  prompt: z
    .string()
    .max(1000)
    .describe(
      "ONE observable quality of a good response, judgeable from the user message, the final answer, and tool NAMES alone.",
    ),
  judgeModelId: z.string().optional().describe("Judge model override; defaults to the pinned judge."),
  scale: z
    .enum(["binary", "score"])
    .default("binary")
    .describe("binary → pass/fail; score → graded 0–1 (only for genuinely graded qualities)."),
  enabled: z.boolean().default(true),
});

/** Build the management toolset bound to one Principal + the live Latch services. */
async function builderTools(principal: Principal): Promise<Record<string, unknown>> {
  // Lazy import avoids a static import cycle (latch.ts → agents → here).
  const { getLatch } = await import("@/lib/latch");
  const { runtime, agentStore, allConnections, connections, connectionStore, dynamic, models, authoredTools, evalStore } =
    await getLatch();

  const capsToExec = (
    c: z.infer<typeof CAPABILITIES>,
    authored?: string[],
    effort?: "minimal" | "low" | "medium" | "high",
  ): AgentRecord["exec"] | undefined => {
    const exec: AgentRecord["exec"] = {
      sandbox: c?.sandbox || undefined,
      defaultTools: c?.defaultTools || undefined,
      providerWebTools: c?.providerWebTools || undefined,
      codeMode: c?.codeMode ? {} : undefined,
      authoredTools: authored?.length ? authored : undefined,
      effort,
    };
    const hasAny =
      !!c?.sandbox ||
      !!c?.defaultTools ||
      !!c?.providerWebTools ||
      !!c?.codeMode ||
      !!authored?.length ||
      effort !== undefined;
    return hasAny ? exec : undefined;
  };

  return {
    // get_agent / list_connection_tools / list_eval_sets — shared with the
    // Eval Author subagent so the two can't drift.
    ...sharedReadTools(principal, { agentStore, allConnections, evalStore }),

    list_agents: tool({
      description: "List the user's own (editable) agents plus the names of all available agents.",
      inputSchema: z.object({}),
      execute: async () => {
        const records = await agentStore.listRecords(principal);
        const all = await runtime.listAgents(principal);
        return {
          yourAgents: records.map((r) => ({
            name: r.name,
            scope: r.scope,
            title: r.title,
            description: r.description,
            modelId: r.modelId,
            connections: r.connections,
            capabilities: r.exec ?? undefined,
          })),
          allAgentNames: all.map((a) => a.name),
          note: "Only 'yourAgents' can be edited. Other names are built-in, read-only references.",
        };
      },
    }),

    list_models: tool({
      description: "Available model ids to choose from (use one of these for modelId).",
      inputSchema: z.object({}),
      execute: async () =>
        models.map((m) => ({ id: m.id, label: m.label, provider: m.provider, reasoning: !!m.reasoning })),
    }),

    list_connections: tool({
      description:
        "Connections the user can wire to an agent, with whether they're authorized. Prefer authorized ones.",
      inputSchema: z.object({}),
      execute: async () => {
        const stored = await connectionStore.list(principal);
        const status = new Map((await dynamic.status(principal)).map((s) => [s.name, s]));
        const names = Array.from(new Set([...connections.names, ...stored.map((c) => c.name)]));
        return names.map((name) => ({
          name,
          kind: stored.find((c) => c.name === name)?.kind ?? "mcp",
          authorized: status.get(name)?.authorized ?? true,
        }));
      },
    }),

    list_chats: tool({
      description: "The user's recent chats (to read history and base an agent on past work).",
      inputSchema: z.object({ limit: z.number().optional() }),
      execute: async ({ limit }) => {
        const chats = await runtime.listChats({ principal, limit: limit ?? 20 });
        return chats
          .filter((c) => !c.id.startsWith("sub_"))
          .map((c) => ({ id: c.id, title: c.title ?? null, agent: c.agent, updatedAt: c.updatedAt }));
      },
    }),

    read_chat: tool({
      description: "Read one chat's messages (role + text) to inform prompts or connection choices.",
      inputSchema: z.object({ chatId: z.string() }),
      execute: async ({ chatId }) => {
        const messages = await runtime.loadHistory({ chatId, principal });
        return messages.map((m) => ({
          role: (m as { role?: string }).role ?? "unknown",
          text: ((m as { parts?: { type: string; text?: string }[] }).parts ?? [])
            .filter((p) => p.type === "text" && p.text)
            .map((p) => p.text)
            .join("\n")
            .slice(0, 4000),
        }));
      },
    }),

    save_agent: tool({
      description:
        "Create a new agent or update an existing one (upsert by name). Pauses for the user's approval.",
      inputSchema: SAVE_INPUT,
      execute: async (input) => {
        const name = normalizeAgentName(input.name);
        if (!name) return { error: "invalid name" };
        if (RESERVED_NAMES.has(name)) {
          return { error: `"${name}" is a built-in agent and can't be overwritten — pick another name.` };
        }
        if (!models.some((m) => m.id === input.modelId)) {
          return { error: `Unknown modelId "${input.modelId}". Call list_models and use one of those.` };
        }
        // Reject hallucinated references — only names the discovery tools return.
        const stored = await connectionStore.list(principal);
        const knownConnections = new Set([...connections.names, ...stored.map((c) => c.name)]);
        const badConn = (input.connections ?? []).filter((n) => !knownConnections.has(n));
        if (badConn.length) {
          return { error: `Unknown connection(s): ${badConn.join(", ")}. Use list_connections.` };
        }
        const knownAgents = new Set((await runtime.listAgents(principal)).map((a) => a.name));
        const badSub = (input.subagents ?? []).filter((n) => !knownAgents.has(n) && n !== name);
        if (badSub.length) {
          return { error: `Unknown subagent(s): ${badSub.join(", ")}. Use list_agents.` };
        }
        const owned = await authoredTools.listFor(principal);
        const ownedNames = new Set(owned.map((t) => t.name));
        const badTools = (input.authoredTools ?? []).filter((n) => !ownedNames.has(n));
        if (badTools.length) {
          return { error: `Unknown authored tool(s): ${badTools.join(", ")}. Use list_tools (author them first).` };
        }
        // An org agent can only use org-scoped tools (else they're missing for
        // other members). Tell the builder to re-save them with scope:"org".
        if (input.scope === "org") {
          const orgNames = new Set(owned.filter((t) => t.scope === "org").map((t) => t.name));
          const personal = (input.authoredTools ?? []).filter((n) => !orgNames.has(n));
          if (personal.length) {
            return { error: `Org agents can only use org-scoped tools. Re-save these with scope:"org": ${personal.join(", ")}.` };
          }
        }
        // Attached online evals aren't part of save_agent's input — carry the
        // existing ones over so a save never silently detaches them.
        const existing = await agentStore.getRecord(principal, name);
        const rec: AgentRecord = {
          name,
          title: input.title,
          description: input.description,
          modelId: input.modelId,
          instructions: input.instructions,
          connections: input.connections ?? [],
          maxSteps: input.maxSteps,
          exec: capsToExec(input.capabilities, input.authoredTools, input.effort),
          subagents: input.subagents?.length ? input.subagents : undefined,
          attachedEvals: existing?.attachedEvals,
          scope: input.scope,
        };
        await agentStore.upsert(principal, rec);
        // Eval nudge, matched to the agent's actual state: the model acts on
        // tool results far more reliably than on distant prompt instructions.
        const rubrics = (existing?.attachedEvals ?? []).filter((e) => e.enabled);
        return {
          saved: true,
          name,
          scope: input.scope,
          attachedEvals: rubrics.map((e) => e.name),
          note:
            "Available now in the agent picker. " +
            (rubrics.length
              ? `This agent has online eval(s): ${rubrics.map((e) => e.name).join(", ")} — every live run gets judged; watch scores on the Observability page.`
              : "No online evals attached yet — after testing, suggest attaching judge rubrics (brief the eval-author) so real usage gets scored on the Observability page."),
        };
      },
    }),

    delete_agent: tool({
      description: "Delete one of the user's agents. Destructive — pauses for the user's approval.",
      inputSchema: z.object({ name: z.string(), scope: SCOPE }),
      execute: async ({ name, scope }) => {
        await agentStore.remove(principal, scope, name);
        return { deleted: name, scope };
      },
    }),

    test_agent: tool({
      description:
        "Run one of the user's agents once with a test message and get its answer plus which tools it called — so you can verify behavior and refine the prompt. In the default safe mode, APPROVAL-GATED tools are blocked (return a 'blocked' marker). NOTE: tools that are NOT approval-gated still execute for real — including authored tools, which may perform real fetch side effects (e.g. a POST). Set live=true only when the user explicitly wants a full real run.",
      inputSchema: z.object({
        name: z.string().describe("Agent name to test."),
        message: z.string().describe("The test user message to send it."),
        live: z
          .boolean()
          .optional()
          .describe("true → real run (mutating tools execute). Default false → safe (mutations blocked)."),
      }),
      execute: async ({ name, message, live }) => {
        const { threadId, answer } = await runtime.runAgent({
          principal,
          agent: name,
          prompt: message,
          blockGated: !live,
        });
        const history = await runtime.loadHistory({ chatId: threadId, principal });
        const toolCalls: { tool: string; blocked?: boolean }[] = [];
        for (const m of history) {
          for (const p of (((m as { parts?: unknown[] }).parts ?? []) as Record<string, unknown>[])) {
            const type = p.type as string | undefined;
            if (!type) continue;
            if (type === "dynamic-tool" || type.startsWith("tool-")) {
              const toolName =
                typeof p.toolName === "string"
                  ? p.toolName
                  : type.startsWith("tool-")
                    ? type.slice(5)
                    : "unknown";
              const blocked = (p.output as { __blocked?: boolean } | undefined)?.__blocked;
              toolCalls.push({ tool: toolName, blocked: blocked || undefined });
            }
          }
        }
        // Eval nudge at the moment it matters: a test that looks good is
        // exactly when the workflow says to offer online evals.
        const tested = await agentStore.getRecord(principal, normalizeAgentName(name));
        const rubrics = (tested?.attachedEvals ?? []).filter((e) => e.enabled);
        return {
          answer,
          toolCalls,
          mode: live ? "live" : "safe (mutating tools blocked)",
          note:
            rubrics.length > 0
              ? `This agent has online eval(s): ${rubrics.map((e) => e.name).join(", ")} — real runs get judged automatically; check the Observability page for scores.`
              : "No online evals attached yet. If this test looks good, SUGGEST attaching judge rubrics (delegate drafting to the eval-author, then attach_evals) so every real run gets scored.",
        };
      },
    }),

    attach_evals: tool({
      description:
        "Attach ONLINE evals to an agent: LLM-judge rubrics that run automatically on EVERY live run, pushing verdicts to Langfuse as scores the user watches on the Observability page. REPLACES the agent's current attached evals (pass the full list). Pauses for the user's approval.",
      inputSchema: z.object({
        agentName: z.string().describe("The agent to attach the rubrics to."),
        evals: z
          .array(ATTACHED_EVAL_INPUT)
          .max(7)
          .describe("The FULL set of rubrics (replaces existing). Empty array detaches all."),
      }),
      execute: async ({ agentName, evals }) => {
        const name = normalizeAgentName(agentName);
        const rec = await agentStore.getRecord(principal, name);
        if (!rec) return { error: `No editable agent named "${name}". Use list_agents.` };
        const valid = validateRubrics(
          evals as AttachedEval[],
          (id) => models.some((m) => m.id === id),
        );
        if (!valid.ok) return { error: valid.error };
        const attached = valid.rubrics;
        await agentStore.upsert(principal, { ...rec, attachedEvals: attached });
        return {
          saved: true,
          agentName: name,
          attachedEvals: attached.map((e) => ({ name: e.name, scale: e.scale, enabled: e.enabled })),
          note: "Every completed live run of this agent is now judged against these rubrics; scores appear on the Observability page (and in Langfuse) within seconds of each run.",
        };
      },
    }),

    // Tool authoring: save_tool / test_tool / delete_tool / list_tools — author
    // sandboxed JS/TS tools (over `input` + an allowlisted `fetch`) to attach to
    // agents. Bound to the same Principal.
    ...authoredTools.authoringTools(principal),
  };
}

export const agentBuilder = defineAgent<Principal, { orgId: string }>(
  {
    model: anthropic("claude-sonnet-4-6"),
    instructions: `You are the Agent Builder. You design, CREATE, and update Latch agents on behalf of the user you're talking to. Everything you make belongs to that user, at their personal or org scope.

WHAT AN AGENT IS — the fields you set with save_agent:
- name: unique kebab-case id (e.g. "support-triage"). Reusing a name UPDATES that agent.
- title / description: short labels for the picker.
- modelId: MUST be one returned by list_models — never invent one.
- effort: reasoning/thinking level ("minimal" | "low" | "medium" | "high"). ONLY set it when list_models shows reasoning=true for the chosen model; lower effort = faster + cheaper (good for simple/throughput agents), higher = deeper reasoning. Omit to use the provider default. For a model with reasoning=false, leave effort unset (it would be a no-op).
- instructions: the system prompt, the heart of the agent. Spend most of your effort here: role, scope, tone, which tools to use and when, and edge cases. A great agent is mostly a great prompt.
- connections: integration names from list_connections. Only wire ones that exist; prefer authorized ones. Use list_connection_tools to see what a connection offers.
- capabilities: codeMode (writes/runs JS over its tools — multi-step orchestration), sandbox (workspace + file/shell tools), providerWebTools (native web search/fetch), defaultTools (web_fetch + askUser).
- authoredTools: names of custom tools you've authored (see BUILDING TOOLS) for this agent to call.
- subagents: names of other agents this one may delegate to.
- scope: "user" (personal) or "org" (shared with the whole org).

BUILDING TOOLS (save_tool / test_tool / list_tools / delete_tool):
When an agent needs an external API or any real computation, AUTHOR A TOOL instead of asking the model to do it in its head.

A tool is a JS or TypeScript program (TS types are allowed — they're stripped automatically; no type-checking). It runs in a locked-down sandbox whose ONLY globals are:
- \`input\` — the call arguments (shaped by the tool's inputSchema).
- \`fetch(url, opts?)\` — HTTP. Returns \`{ ok, status, statusText, headers, text, json }\` where \`json\` is the parsed body when the response is JSON (else null) and \`text\` is the raw string. It throws if the host isn't allowed. Example: \`const r = await fetch(url); const data = r.json;\`
There is NOTHING else — no console, no require/import, no process/fs/timers. The program MUST end with \`return <JSON-serializable value>\`.
\`fetch\` is restricted to the tool's \`allowedHosts\`: list EVERY hostname it calls (e.g. ["api.open-meteo.com"]); private/loopback hosts are always blocked; empty allowedHosts = no network.
Keep results compact: do the filtering/aggregation IN CODE and return only what the model needs (results over ~64KB are truncated; a run times out at ~15s).

Design principle: keep ALL fetching, math, unit conversion, ranking, and safety rules IN THE TOOL'S CODE; the agent that uses it only phrases the result and makes judgment calls. The tool returns clean, already-computed data (not raw API JSON) so the model never has to calculate.

SCOPE: a tool is personal (default) or org-shared (scope:"org"). Match it to the agent you're building — an ORG agent can ONLY attach org-scoped tools (a personal tool wouldn't resolve for other members), so author its tools with scope:"org". A personal agent may use personal or org tools.

Flow: write the program → call test_tool (pass sample \`input\` and the same allowedHosts) to confirm it runs and its fetches resolve — a compile error, thrown error, or fetch failure comes back in the result, so fix and re-test until correct → save_tool with a clear name, a description covering its inputs/output, an input JSON Schema, and allowedHosts. Then attach it to an agent via save_agent's authoredTools. Saved tools are visible and editable by the user on the Tools page.

EVALS (attach_evals + the eval-author subagent):
test_agent is one ad-hoc trial; ATTACHED EVALS are the continuous version — LLM-judge rubrics that run automatically on EVERY live run of the agent, pushing verdicts to Langfuse as scores. The user watches them land in realtime on the Observability page while using the agent for real. Use them to measure quality on real traffic instead of eyeballing one answer.
- A rubric = {name, prompt, scale, judgeModelId?, enabled}: name is kebab-case (it becomes the score name, e.g. "stays-on-topic"); prompt states ONE observable quality a judge can verify from the user message, the final answer, and tool NAMES alone (never argument values); scale "binary" (pass/fail — prefer it) or "score" (graded 0–1, only for genuinely graded qualities like helpfulness depth).
- DRAFTING IS DELEGATED — never draft rubrics inline. Call spawn_agent(agent: "eval-author") with a compact brief distilled from this conversation: the target agent's name, its purpose, expected behaviors, edge cases, refusal/escalation rules. The eval-author reads the agent's config and connection tools itself and answers with ONLY a JSON array of rubrics matching attach_evals' schema. Show them to the user, apply their edits, then attach_evals (it validates names, prompts, and judge models; it REPLACES the agent's rubric set, so always pass the full list — get_agent shows the current one).
- 3–7 rubrics is the sweet spot — every enabled rubric costs one judge call per live run.
- REVIEWING IS DELEGATED TOO — when scores look off (a rubric always passes, always fails, or judges the wrong thing), continue the SAME eval-author thread with the rubric names and example verdicts/comments from the Observability page; it answers verdicts {name, cause, suggestion} — apply them via attach_evals (rewritten rubrics) or save_agent (when the AGENT's behavior is what's wrong).
- Keep ONE eval-author thread per agent's eval work — reuse the threadId from the first spawn_agent, so the eval-author remembers why each rubric exists.

WORKFLOW:
1. Understand the goal. If it's vague, ask a few sharp questions first (purpose, behavior, integrations, tone).
2. Discover before proposing: call list_models and list_connections (and list_connection_tools for any you'll wire). If the agent needs an external API or real computation, AUTHOR + test_tool the tool(s) it needs now (see BUILDING TOOLS), to attach via authoredTools.
3. ALWAYS ask whether the agent should be personal (user) or org-shared before saving — scope is required and you must not guess it.
4. Propose: summarize the agent in plain language (name, model, connections, key instruction points) and get a quick confirmation.
5. Call save_agent. It pauses for the user's approval — they'll see the full spec; that's expected.
6. TEST IT: after saving, offer to test_agent with a realistic message. Read the answer + tool calls it returns, and tell the user how it did. If it's off (wrong tone, missed a tool, weak reasoning), refine the instructions and save_agent again, then re-test — iterate until it's good. test_agent blocks mutating tools by default (no real side effects); only pass live=true if the user explicitly wants a real end-to-end run.
7. EVAL IT: once the agent basically works, offer to attach online evals (see EVALS) — brief the eval-author subagent to draft judge rubrics, let the user curate, then attach_evals. From then on every real run gets scored; point the user at the Observability page to watch quality live.
8. Confirm it's ready and that they can pick it from the agent list or refine it on the Agents page.

MODIFYING an existing agent: call get_agent first, change only what's needed, then save_agent with the SAME name and scope. Re-test with test_agent to confirm the change had the intended effect — and if the agent has attached evals (get_agent shows them), remind the user the Observability page will show whether real-run scores moved.

USING HISTORY: when the user refers to past work ("make an agent like in that chat"), use list_chats + read_chat to read the relevant conversation and ground the prompt/connections in what actually happened.

RULES:
- You can only create/edit the user's own agents (those from list_agents → yourAgents). Built-in agents are read-only references — inspect for inspiration, don't overwrite their names.
- Never invent a modelId or connection name. Only use values from list_models / list_connections.
- delete_agent is destructive and pauses for approval; only call it when the user clearly asks.`,
    // Eval drafting + failure diagnosis delegate to the read-only Eval Author
    // (the runtime injects a `spawn_agent` tool for it). It MUST stay
    // read-only: subagent runs are auto-approved, so any write tool on it
    // would bypass the user-approval gates below.
    subagents: ["eval-author"],
    // Host tools bound to the chatting user's Principal.
    toolSources: [
      {
        async open(principal) {
          return { tools: await builderTools(principal), close: async () => {} };
        },
      },
    ],
    // Approve every persisting mutation: the user sees and confirms the exact
    // spec. test_tool (no persist) + reads stay un-gated so authoring iterates
    // freely; save_tool commits, save_agent wires it into an agent.
    toolApproval: {
      save_agent: "user-approval",
      delete_agent: "user-approval",
      save_tool: "user-approval",
      delete_tool: "user-approval",
      // Evals: attaching persists AND adds a judge call to every live run.
      attach_evals: "user-approval",
    },
    smoothStream: true,
  },
  {
    title: "Agent Builder",
    description: "Designs, creates, and updates your agents from a conversation.",
  },
);
