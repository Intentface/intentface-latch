import { anthropic } from "@ai-sdk/anthropic";
import { tool } from "ai";
import { z } from "zod";
import { defineAgent } from "@intentface/latch-core";
import type { TurnWriter } from "@intentface/latch-core";
import type { Principal } from "@/lib/session";
import {  normalizeAgentName } from "@/lib/agent-store";
import type {AgentRecord} from "@/lib/agent-store";
import { isRiskyRegex } from "@/lib/evals/grade";
import { runEvalCases } from "@/lib/evals/run";
import { compactResult } from "@/lib/evals/store";
import type { EvalCase, EvalProgressData } from "@/lib/evals/store";

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
const RESERVED_NAMES = new Set(["assistant", "weekly", "agent-builder"]);

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

const EVAL_EXPECTED = z.object({
  assertions: z
    .object({
      contains: z.array(z.string()).optional().describe("Substrings the answer must include (case-insensitive)."),
      notContains: z.array(z.string()).optional().describe("Substrings the answer must NOT include."),
      regex: z.array(z.string()).optional().describe("JS regexes the answer must match."),
    })
    .optional(),
  toolCalls: z
    .array(
      z.object({
        tool: z.string().describe("Tool the agent must call."),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Subset of the call's args that must match exactly (deep-equal per key)."),
      }),
    )
    .optional(),
  forbiddenTools: z.array(z.string()).optional().describe("Tools the agent must NOT call."),
});

const EVAL_CASE_INPUT = z.object({
  id: z
    .string()
    .optional()
    .describe("Stable id — keep it constant across saves so run history stays comparable. Defaults to a slug of name."),
  name: z.string().describe("Short human label, e.g. 'refund question escalates'."),
  input: z.string().max(4000).describe("The user message to send the agent."),
  expected: EVAL_EXPECTED.describe("At least one of assertions / toolCalls / forbiddenTools."),
});

/** Personal owner key — same derivation as agent-store's ownerKey(p, "user"). */
const personalOwner = (p: Principal): string =>
  [p.orgId, p.userId ?? ""].map(encodeURIComponent).join("/");

/** The slice of a tool call's options we use: its id + the turn's stream writer. */
type ToolCallEnv = { toolCallId?: string; context?: { writer?: TurnWriter } };

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

    get_agent: tool({
      description: "Get the full config of one of the user's agents (instructions, connections, capabilities).",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        const records = await agentStore.listRecords(principal);
        const rec = records.find((r) => r.name === name);
        if (!rec) return { error: `No editable agent named "${name}".` };
        return rec;
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
          scope: input.scope,
        };
        await agentStore.upsert(principal, rec);
        return { saved: true, name, scope: input.scope, note: "Available now in the agent picker." };
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
        return { answer, toolCalls, mode: live ? "live" : "safe (mutating tools blocked)" };
      },
    }),

    save_eval_set: tool({
      description:
        "Create or update a named eval set for an agent (upsert by agentName+setName): repeatable test cases with deterministic checks. Draft the cases yourself from what you know the agent should do — happy paths, edge cases, refusals — and let the user curate. Pauses for the user's approval.",
      inputSchema: z.object({
        agentName: z.string().describe("The agent these cases test."),
        setName: z.string().optional().describe('Set name; defaults to "default".'),
        cases: z.array(EVAL_CASE_INPUT).min(1).max(30),
      }),
      execute: async ({ agentName, setName, cases }) => {
        const agent = normalizeAgentName(agentName);
        const known = new Set((await runtime.listAgents(principal)).map((a) => a.name));
        if (!known.has(agent)) {
          return { error: `Unknown agent "${agent}". Use list_agents.` };
        }
        // A case must carry at least one POPULATED check — `assertions: {}` or
        // empty arrays would create an always-pass case.
        const empty = cases.filter((c) => {
          const a = c.expected.assertions;
          return !(
            a?.contains?.length ||
            a?.notContains?.length ||
            a?.regex?.length ||
            c.expected.toolCalls?.length ||
            c.expected.forbiddenTools?.length
          );
        });
        if (empty.length) {
          return { error: `Case(s) with no checks (would always pass): ${empty.map((c) => c.name).join(", ")}.` };
        }
        // Blank check values are as bad as none: `contains: [""]` matches every
        // answer. Reject any blank/whitespace assertion string or tool name.
        const blank = cases.filter((c) => {
          const a = c.expected.assertions;
          return [
            ...(a?.contains ?? []),
            ...(a?.notContains ?? []),
            ...(a?.regex ?? []),
            ...(c.expected.forbiddenTools ?? []),
            ...(c.expected.toolCalls ?? []).map((t) => t.tool),
          ].some((s) => s.trim().length === 0);
        });
        if (blank.length) {
          return { error: `Blank assertion value or tool name in case(s): ${blank.map((c) => c.name).join(", ")}.` };
        }
        // Reject unsafe/invalid assertion regexes at save time (ReDoS guard) —
        // the grader also refuses them, but failing here lets you fix the case.
        const badRegex = cases.filter((c) =>
          (c.expected.assertions?.regex ?? []).some((r) => {
            if (isRiskyRegex(r)) return true;
            try {
              new RegExp(r);
              return false;
            } catch {
              return true;
            }
          }),
        );
        if (badRegex.length) {
          return {
            error:
              `Unsafe or invalid regex in case(s): ${badRegex.map((c) => c.name).join(", ")}. ` +
              "Max 200 chars, no nested quantifiers (e.g. (a+)+); prefer simple patterns or contains.",
          };
        }
        // Stable ids: keep provided ones, slug the rest, dedupe with a suffix.
        const seen = new Set<string>();
        const withIds: EvalCase[] = cases.map((c) => {
          let id = normalizeAgentName(c.id ?? c.name) || "case";
          while (seen.has(id)) id = `${id}-2`;
          seen.add(id);
          return { id, name: c.name, input: c.input, expected: c.expected };
        });
        const name = setName?.trim() || "default";
        await evalStore.saveSet({ owner: personalOwner(principal), agentName: agent, name, cases: withIds });
        return {
          saved: true,
          agentName: agent,
          setName: name,
          caseCount: withIds.length,
          note: "Run it with run_evals; keep case ids stable across edits so history stays comparable.",
        };
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

    run_evals: tool({
      description:
        "Run an agent's eval set: every case runs in an isolated safe-mode thread (approval-gated tools stubbed, other tools execute for real) and is graded deterministically. Returns per-case pass/fail with reasons plus the delta vs the previous run. Costs one full agent run per case — pauses for the user's approval.",
      inputSchema: z.object({
        agentName: z.string(),
        setName: z.string().optional().describe('Defaults to "default".'),
      }),
      execute: async ({ agentName, setName }, options) => {
        const agent = normalizeAgentName(agentName);
        const name = setName?.trim() || "default";
        const owner = personalOwner(principal);
        const set = await evalStore.getSet(owner, agent, name);
        if (!set) {
          return { error: `No eval set "${name}" for agent "${agent}". Create one with save_eval_set.` };
        }
        // Pin the agent's config so this run stays comparable after edits.
        const records = await agentStore.listRecords(principal);
        const snapshot = records.find((r) => r.name === agent) ?? null;
        const previous = (await evalStore.listRuns(owner, agent, name, 1)).at(0);

        // Stream live progress into the chat while the cases run: one
        // `data-eval-progress` part, reconciled in place by id, that the
        // EvalRunCard renders (the run takes ~a minute per wave of cases —
        // without this the turn is silent until the tool result lands).
        const env = options as ToolCallEnv;
        const soFar: EvalProgressData["results"] = [];
        const writeProgress = (completed: number) => {
          env.context?.writer?.write({
            type: "data-eval-progress",
            id: `evalprog_${env.toolCallId ?? "run"}`,
            data: {
              toolCallId: env.toolCallId,
              agentName: agent,
              setName: name,
              total: set.cases.length,
              completed,
              results: soFar,
            } satisfies EvalProgressData,
          });
        };
        writeProgress(0);

        const results = await runEvalCases({
          runtime,
          principal,
          agent,
          cases: set.cases,
          onResult: (r, completed) => {
            soFar.push(compactResult(r));
            writeProgress(completed);
          },
        });
        const passed = results.filter((r) => r.pass).length;
        const failed = results.length - passed;
        const run = await evalStore.saveRun({
          owner,
          agentName: agent,
          setName: name,
          agentSnapshot: snapshot,
          results,
          passCount: passed,
          failCount: failed,
        });
        const delta = previous ? passed - previous.passCount : undefined;
        return {
          runId: run.id,
          agentName: agent,
          setName: name,
          passed,
          failed,
          total: results.length,
          previous: previous
            ? { runId: previous.id, passed: previous.passCount, total: previous.passCount + previous.failCount }
            : null,
          results: results.map(compactResult),
          summary:
            `${passed}/${results.length} passed` +
            (delta === undefined ? "" : delta === 0 ? " (no change)" : ` (${delta > 0 ? "+" : ""}${delta} vs previous)`),
        };
      },
    }),

    list_eval_runs: tool({
      description: "Past eval runs for an agent (newest first) — scores over time, to judge whether changes helped.",
      inputSchema: z.object({
        agentName: z.string(),
        setName: z.string().optional(),
        limit: z.number().optional(),
      }),
      execute: async ({ agentName, setName, limit }) => {
        const runs = await evalStore.listRuns(
          personalOwner(principal),
          normalizeAgentName(agentName),
          setName?.trim() || undefined,
          limit ?? 10,
        );
        return runs.map((r) => ({
          runId: r.id,
          setName: r.setName,
          passed: r.passCount,
          failed: r.failCount,
          total: r.passCount + r.failCount,
          failedCases: r.results.filter((c) => !c.pass).map((c) => c.caseName),
          at: new Date(r.createdAt).toISOString(),
        }));
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

EVALS (save_eval_set / run_evals / list_eval_sets / list_eval_runs):
test_agent is one ad-hoc trial; an EVAL SET is the repeatable version — the agent's regression suite. Use it to prove a change helped instead of eyeballing one answer.
- A case = a name, one user message (input), and deterministic checks (expected): assertions on the answer (contains / notContains / regex), toolCalls the agent must make (optionally with an args subset), and forbiddenTools it must not touch. Every case needs at least one check.
- DRAFT THE SET YOURSELF from the build conversation: ~5–15 cases covering happy paths, edge cases, ambiguous inputs, and things the agent should refuse or escalate. Prefer tool-call checks for tool-using agents (most reliable) and short, distinctive contains-strings over long exact phrases (models rephrase). Show the user the cases and let them adjust before saving.
- Keep case ids STABLE across edits (save_eval_set defaults id to a slug of name) — run history is only comparable when ids persist. Read the current cases with list_eval_sets before editing a set.
- run_evals runs every case in an isolated safe-mode thread (approval-gated tools stubbed; other tools run for real) and returns per-case pass/fail with reasons plus the score delta vs the previous run. It costs one full agent run per case. The user watches live per-case progress in an in-chat card while it runs — don't re-list every case afterwards; go straight to the failures and what you'll change.
- THE LOOP: after a run, read the failures — the reasons and answerPreviews tell you what to fix. Refine the instructions, save_agent, run_evals again, and report the delta ("8/12 → 11/12"). Iterate until the set passes or the user is satisfied. Grades are heuristics: if a case fails on phrasing while the behavior is right, fix the CASE, not the agent.

WORKFLOW:
1. Understand the goal. If it's vague, ask a few sharp questions first (purpose, behavior, integrations, tone).
2. Discover before proposing: call list_models and list_connections (and list_connection_tools for any you'll wire). If the agent needs an external API or real computation, AUTHOR + test_tool the tool(s) it needs now (see BUILDING TOOLS), to attach via authoredTools.
3. ALWAYS ask whether the agent should be personal (user) or org-shared before saving — scope is required and you must not guess it.
4. Propose: summarize the agent in plain language (name, model, connections, key instruction points) and get a quick confirmation.
5. Call save_agent. It pauses for the user's approval — they'll see the full spec; that's expected.
6. TEST IT: after saving, offer to test_agent with a realistic message. Read the answer + tool calls it returns, and tell the user how it did. If it's off (wrong tone, missed a tool, weak reasoning), refine the instructions and save_agent again, then re-test — iterate until it's good. test_agent blocks mutating tools by default (no real side effects); only pass live=true if the user explicitly wants a real end-to-end run.
7. EVAL IT: once the agent basically works, offer to create an eval set (see EVALS) — draft the cases from everything you learned in this conversation, let the user curate, save_eval_set, then run_evals. Read the failures, improve the instructions, and re-run until the score is good; report each delta.
8. Confirm it's ready and that they can pick it from the agent list or refine it on the Agents page.

MODIFYING an existing agent: call get_agent first, change only what's needed, then save_agent with the SAME name and scope. Re-test with test_agent to confirm the change had the intended effect — and if the agent has an eval set (list_eval_sets), run_evals to prove the change didn't regress anything.

USING HISTORY: when the user refers to past work ("make an agent like in that chat"), use list_chats + read_chat to read the relevant conversation and ground the prompt/connections in what actually happened.

RULES:
- You can only create/edit the user's own agents (those from list_agents → yourAgents). Built-in agents are read-only references — inspect for inspiration, don't overwrite their names.
- Never invent a modelId or connection name. Only use values from list_models / list_connections.
- delete_agent is destructive and pauses for approval; only call it when the user clearly asks.`,
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
      // Evals: saving persists, running costs one agent run per case.
      save_eval_set: "user-approval",
      run_evals: "user-approval",
    },
    smoothStream: true,
  },
  {
    title: "Agent Builder",
    description: "Designs, creates, and updates your agents from a conversation.",
  },
);
