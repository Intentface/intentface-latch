import { tool } from "ai";
import { z } from "zod";
import { defineAgent } from "@intentface/latch-core";
import type { AgentFactory, AgentMeta, Runtime } from "@intentface/latch-core";
import type { LanguageModel } from "ai";
import type { AgentBuilderExtension, SaveAgentInput } from "./extension";
import { normalizeAgentName } from "./store";
import type { AgentBuilderStore, AgentRecord } from "./store";
import { sharedReadTools } from "./shared-read-tools";

/**
 * The Agent Builder — a meta-agent that designs, creates, and updates other
 * agents on behalf of the user it's talking to. Its tools are host functions
 * bound to that user's principal (via `toolSources.open`), so everything it
 * writes lands at the user's own scope through the host-supplied store.
 * Reads connections/models/history to make grounded proposals.
 *
 * Mutations (save/delete) are gated with `user-approval`, so the user sees and
 * confirms the exact spec before it persists.
 *
 * The core is host-agnostic: models, connections, storage, and the runtime
 * arrive through `AgentBuilderConfig.deps`; optional feature sets (evals,
 * tool authoring) arrive as `extensions`.
 */

const SCOPE = z.enum(["user", "org"]);

const CAPABILITIES = z
  .object({
    codeMode: z.boolean().optional().describe("Agent writes/runs a JS program over its tools (multi-step orchestration)."),
    sandbox: z.boolean().optional().describe("Per-session workspace + file/shell tools (bash, read_file, …)."),
    providerWebTools: z.boolean().optional().describe("Native provider web search/fetch (Anthropic/OpenAI)."),
    defaultTools: z.boolean().optional().describe("App harness tools: web_fetch + askUser."),
    preApprovedWrites: z
      .boolean()
      .optional()
      .describe(
        "Waive the per-call approval pause on this agent's WRITE tools — the save approval is the consent. ONLY for agents that must run unattended (schedules); requires defaultTools. Spell the tradeoff out to the user before saving.",
      ),
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
    .describe("Names of authored tools to attach — ONLY when this host offers tool authoring (a BUILDING TOOLS section in your instructions). Omit otherwise."),
  subagents: z.array(z.string()).optional().describe("Names of agents this one may delegate to."),
  maxSteps: z.union([z.number(), z.literal("unlimited")]).optional(),
  effort: z
    .enum(["minimal", "low", "medium", "high"])
    .optional()
    .describe("Reasoning/thinking effort. Only set for a model where list_models shows reasoning=true."),
  scope: SCOPE.describe("'user' (personal) or 'org' (shared). Ask the user — never guess."),
});

/** A model the builder may assign to an agent (from the host's catalog). */
export interface ModelChoice {
  id: string;
  label?: string;
  provider?: string;
  reasoning?: boolean;
}

/** A connection the builder may wire to an agent. */
export interface ConnectionChoice {
  name: string;
  kind?: string;
  authorized?: boolean;
}

/** The live host services the builder's tools run against, per principal. */
export interface AgentBuilderDeps<P> {
  runtime: Pick<
    Runtime<P>,
    "listAgents" | "listChats" | "loadHistory" | "runAgent" | "schedule" | "listSchedules" | "unschedule"
  >;
  store: AgentBuilderStore<P>;
  /** The host's model catalog (assignable model ids). */
  models: ModelChoice[];
  /** Connections the caller can wire to an agent. */
  listConnections: (principal: P) => Promise<ConnectionChoice[]>;
  /** Enumerate the tools a set of connections exposes, for this caller. */
  connectionTools: (principal: P, names: string[]) => Promise<{ name: string; description: string }[]>;
}

/**
 * What THIS host actually wires for each optional agent capability — so the
 * builder's prompt only offers what exists, and save_agent rejects the rest
 * instead of persisting silent no-op flags. Every capability defaults to
 * supported (backwards compatible for hosts that wire everything).
 * `defaultTools` may carry a host-specific description of what the flag
 * grants (rendered in the prompt verbatim).
 */
export interface CapabilitySupport {
  sandbox?: boolean;
  codeMode?: boolean;
  providerWebTools?: boolean;
  defaultTools?: boolean | { description: string };
  /**
   * Whether the host honors the save-time write-approval waiver
   * (`preApprovedWrites`). Only meaningful on hosts that gate writes; a host
   * with ungated writes should declare it unsupported so the flag can't be
   * saved as a no-op.
   */
  preApprovedWrites?: boolean | { description: string };
}

export interface AgentBuilderConfig<P, RuntimeContext = unknown> {
  /** The builder's own model — a value, or a per-request factory (e.g. per-tenant catalogs). */
  model:
    | LanguageModel
    | ((ctx: { runtime: RuntimeContext; principal: P }) => LanguageModel | Promise<LanguageModel>);
  /**
   * Lazy host services, resolved per turn. Lazy so the host's composition
   * root can import this package without a static import cycle.
   */
  deps: (principal: P) => Promise<AgentBuilderDeps<P>>;
  /** Code-declared agent names save_agent must refuse to overwrite (host statics). */
  reservedNames?: string[];
  /** Which optional agent capabilities this host wires (default: all). */
  capabilities?: CapabilitySupport;
  /**
   * Offer schedule tools (schedule_agent / list_schedules / unschedule_agent)
   * so the builder can put agents on a cron cadence. Default true — the
   * runtime always has the schedule API; disable only if the host runs no
   * cron driver (nothing would ever fire).
   */
  scheduling?: boolean;
  /** Optional feature sets: evals, tool authoring, … */
  extensions?: AgentBuilderExtension<P>[];
  /** Picker metadata override. */
  meta?: AgentMeta;
}

/** The capabilities bullet, built from what the host actually supports. */
function capabilitiesBullet(support: CapabilitySupport): string {
  const offered: string[] = [];
  if (support.codeMode !== false)
    offered.push("codeMode (writes/runs JS over its tools — multi-step orchestration)");
  if (support.sandbox !== false)
    offered.push("sandbox (workspace + file/shell tools)");
  if (support.providerWebTools !== false)
    offered.push("providerWebTools (native web search/fetch)");
  const dt = support.defaultTools;
  if (dt !== false) {
    offered.push(
      typeof dt === "object" ? `defaultTools (${dt.description})` : "defaultTools (web_fetch + askUser)",
    );
  }
  // Opt-IN (unlike the rest): only hosts that gate writes and honor the
  // waiver should offer it — a host with ungated writes would save a no-op.
  const paw = support.preApprovedWrites;
  if (paw) {
    offered.push(
      typeof paw === "object"
        ? `preApprovedWrites (${paw.description})`
        : "preApprovedWrites (writes skip the per-call approval pause — the save approval is the consent; only for unattended/scheduled agents, requires defaultTools)",
    );
  }
  return offered.length
    ? `- capabilities: ${offered.join(", ")}. These are the ONLY capabilities that exist here — never promise behavior outside them (agents run as request-scoped turns; there are no persistent/background processes).`
    : "- capabilities: none available in this host — always leave unset.";
}

const SCHEDULING_PROMPT = `SCHEDULING (schedule_agent / list_schedules / unschedule_agent):
An agent runs as one TURN per trigger — it cannot loop in the background. For "do X every …" or "do X at …", save the agent to do X ONCE per run, then put it on a schedule.
- schedule_agent takes the agent name, a prompt (the message each fire sends it), and a cron expression — croner syntax, 5 fields (minute-level) or 6 with leading seconds — interpreted in the given IANA timezone (default UTC). Omit cron for a ONE-SHOT that fires on the next tick. It pauses for the user's approval (a schedule spends money unattended).
- Design scheduled agents to complete in one self-contained turn from the schedule's prompt alone. NOTE: a scheduled run has no user watching — if it hits an approval-gated (write) tool it PAUSES until the user reviews that chat, so warn the user when scheduling a write-capable agent.
- list_schedules shows the user's schedules; unschedule_agent (approval-gated) removes one by id.`;

function buildBaseInstructions(support: CapabilitySupport, scheduling: boolean): string {
  return `You are the Agent Builder. You design, CREATE, and update agents on behalf of the user you're talking to. Everything you make belongs to that user, at their personal or org scope.

WHAT AN AGENT IS — the fields you set with save_agent:
- name: unique kebab-case id (e.g. "support-triage"). Reusing a name UPDATES that agent.
- title / description: short labels for the picker.
- modelId: MUST be one returned by list_models — never invent one.
- effort: reasoning/thinking level ("minimal" | "low" | "medium" | "high"). ONLY set it when list_models shows reasoning=true for the chosen model; lower effort = faster + cheaper (good for simple/throughput agents), higher = deeper reasoning. Omit to use the provider default. For a model with reasoning=false, leave effort unset (it would be a no-op).
- instructions: the system prompt, the heart of the agent. Spend most of your effort here: role, scope, tone, which tools to use and when, and edge cases. A great agent is mostly a great prompt.
- connections: integration names from list_connections. Only wire ones that exist; prefer authorized ones. Use list_connection_tools to see what a connection offers.
${capabilitiesBullet(support)}
- subagents: names of other agents this one may delegate to.
- scope: "user" (personal) or "org" (shared with the whole org).
${scheduling ? `\n${SCHEDULING_PROMPT}\n` : ""}
WORKFLOW:
1. Understand the goal. If it's vague, ask a few sharp questions first (purpose, behavior, integrations, tone).
2. Discover before proposing: call list_models and list_connections (and list_connection_tools for any you'll wire).
3. ALWAYS ask whether the agent should be personal (user) or org-shared before saving — scope is required and you must not guess it.
4. Propose: summarize the agent in plain language (name, model, connections, key instruction points) and get a quick confirmation.
5. Call save_agent. It pauses for the user's approval — they'll see the full spec; that's expected.
6. TEST IT: after saving, offer to test_agent with a realistic message. Read the answer + tool calls it returns, and tell the user how it did. If it's off (wrong tone, missed a tool, weak reasoning), refine the instructions and save_agent again, then re-test — iterate until it's good. test_agent blocks mutating tools by default (no real side effects); only pass live=true if the user explicitly wants a real end-to-end run.
7. Confirm it's ready and that they can pick it from the agent list.

MODIFYING an existing agent: call get_agent first, change only what's needed, then save_agent with the SAME name and scope. Re-test with test_agent to confirm the change had the intended effect.

USING HISTORY: when the user refers to past work ("make an agent like in that chat"), use list_chats + read_chat to read the relevant conversation and ground the prompt/connections in what actually happened.

RULES:
- You can only create/edit the user's own agents (those from list_agents → yourAgents). Built-in agents are read-only references — inspect for inspiration, don't overwrite their names.
- Never invent a modelId or connection name. Only use values from list_models / list_connections.
- NEVER promise behavior the fields above can't express. No background loops, no timers inside an agent${scheduling ? " — recurring behavior is a SCHEDULE (see SCHEDULING)" : ""}.
- delete_agent is destructive and pauses for approval; only call it when the user clearly asks.`;
}

/**
 * Chain a result through every extension's decorator of the given kind.
 * A throwing hook is isolated: decoration runs AFTER the mutation persisted,
 * so a decorator failure must not turn a successful save/test into a reported
 * error — keep the last good result and log the hook failure.
 */
async function decorate<P>(
  extensions: AgentBuilderExtension<P>[],
  kind: "decorateSaveResult" | "decorateTestResult",
  principal: P,
  agentName: string,
  result: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let out = result;
  for (const ext of extensions) {
    const hook = ext[kind];
    if (!hook) continue;
    try {
      out = await hook(principal, agentName, out);
    } catch (error) {
      console.warn(`agent-builder: extension "${ext.name}" ${kind} failed; keeping undecorated result:`, error);
    }
  }
  return out;
}

/** Build the management toolset bound to one principal + the live host services. */
async function builderTools<P>(
  principal: P,
  config: AgentBuilderConfig<P, never> | AgentBuilderConfig<P, unknown>,
): Promise<Record<string, unknown>> {
  const deps = await config.deps(principal);
  const { runtime, store, models, listConnections, connectionTools } = deps;
  const extensions = config.extensions ?? [];
  const support = config.capabilities ?? {};
  const scheduling = config.scheduling !== false;
  const reserved = new Set([
    ...(config.reservedNames ?? []),
    ...extensions.flatMap((e) => e.reservedNames ?? []),
  ]);
  const authoredToolsSupported = extensions.some((e) => e.handlesAuthoredTools);

  /** Reject capability flags this host never wired (silent no-ops otherwise). */
  const unsupportedCapabilities = (c: z.infer<typeof CAPABILITIES>): string[] => {
    const asked: [string, boolean | undefined, boolean][] = [
      ["codeMode", c?.codeMode, support.codeMode !== false],
      ["sandbox", c?.sandbox, support.sandbox !== false],
      ["providerWebTools", c?.providerWebTools, support.providerWebTools !== false],
      ["defaultTools", c?.defaultTools, support.defaultTools !== false],
      // Opt-in (see capabilitiesBullet): unsupported unless declared.
      ["preApprovedWrites", c?.preApprovedWrites, !!support.preApprovedWrites],
    ];
    return asked.filter(([, on, ok]) => on && !ok).map(([name]) => name);
  };

  const capsToExec = (
    c: z.infer<typeof CAPABILITIES>,
    authored?: string[],
    effort?: "minimal" | "low" | "medium" | "high",
  ): AgentRecord["exec"] | undefined => {
    const exec: AgentRecord["exec"] = {
      sandbox: c?.sandbox || undefined,
      defaultTools: c?.defaultTools || undefined,
      providerWebTools: c?.providerWebTools || undefined,
      preApprovedWrites: c?.preApprovedWrites || undefined,
      codeMode: c?.codeMode ? {} : undefined,
      authoredTools: authored?.length ? authored : undefined,
      effort,
    };
    const hasAny =
      !!c?.sandbox ||
      !!c?.defaultTools ||
      !!c?.providerWebTools ||
      !!c?.preApprovedWrites ||
      !!c?.codeMode ||
      !!authored?.length ||
      effort !== undefined;
    return hasAny ? exec : undefined;
  };

  const extensionTools: Record<string, unknown> = {};
  for (const ext of extensions) {
    if (ext.tools) Object.assign(extensionTools, await ext.tools(principal));
  }

  return {
    // get_agent / list_connection_tools — shared with delegate agents (e.g.
    // an eval author) so the implementations can't drift.
    ...sharedReadTools(principal, { store, connectionTools }),

    list_agents: tool({
      description: "List the user's own (editable) agents plus the names of all available agents.",
      inputSchema: z.object({}),
      execute: async () => {
        const records = await store.listRecords(principal);
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
      execute: async () => listConnections(principal),
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
        if (reserved.has(name)) {
          return { error: `"${name}" is a built-in agent and can't be overwritten — pick another name.` };
        }
        if (!models.some((m) => m.id === input.modelId)) {
          return { error: `Unknown modelId "${input.modelId}". Call list_models and use one of those.` };
        }
        // `effort` is a no-op on non-reasoning models — reject like the
        // capability flags instead of persisting a setting that does nothing.
        if (input.effort && !models.find((m) => m.id === input.modelId)?.reasoning) {
          return {
            error: `Model "${input.modelId}" is not reasoning-capable (list_models shows reasoning=false) — omit effort or pick a reasoning model.`,
          };
        }
        // Reject hallucinated references — only names the discovery tools return.
        const knownConnections = new Set((await listConnections(principal)).map((c) => c.name));
        const badConn = (input.connections ?? []).filter((n) => !knownConnections.has(n));
        if (badConn.length) {
          return { error: `Unknown connection(s): ${badConn.join(", ")}. Use list_connections.` };
        }
        const knownAgents = new Set((await runtime.listAgents(principal)).map((a) => a.name));
        const badSub = (input.subagents ?? []).filter((n) => !knownAgents.has(n) && n !== name);
        if (badSub.length) {
          return { error: `Unknown subagent(s): ${badSub.join(", ")}. Use list_agents.` };
        }
        // Authored tools only exist where an extension provides them — a clear
        // rejection beats silently dropping a capability the model asked for.
        if (input.authoredTools?.length && !authoredToolsSupported) {
          return { error: "Tool authoring is not available here — omit authoredTools." };
        }
        // Same for capability flags the host never wired: rejecting beats
        // persisting a silent no-op the user believes in.
        const unsupported = unsupportedCapabilities(input.capabilities);
        if (unsupported.length) {
          return {
            error: `Not available in this host: ${unsupported.join(", ")}. Omit ${unsupported.length > 1 ? "them" : "it"} — and don't promise the user that behavior.`,
          };
        }
        // The write waiver without write tools is meaningless — likely a
        // misunderstanding worth surfacing rather than persisting.
        if (input.capabilities?.preApprovedWrites && !input.capabilities?.defaultTools) {
          return {
            error: "preApprovedWrites requires defaultTools (the write capability) — there are no writes to waive without it.",
          };
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
        // Extension vetoes (e.g. tool-authoring existence + org-scope rules).
        const saveInput: SaveAgentInput = {
          name,
          scope: input.scope,
          authoredTools: input.authoredTools,
          connections: input.connections,
          subagents: input.subagents,
          modelId: input.modelId,
        };
        for (const ext of extensions) {
          const veto = await ext.validateSave?.(principal, saveInput, rec);
          if (veto) return { error: veto };
        }
        await store.upsert(principal, rec);
        return decorate(extensions, "decorateSaveResult", principal, name, {
          saved: true,
          name,
          scope: input.scope,
          note: "Available now in the agent picker.",
        });
      },
    }),

    delete_agent: tool({
      description:
        "Delete one of the user's agents, along with the user's schedules that fire it (an orphaned schedule would error on every tick). Destructive — pauses for the user's approval.",
      inputSchema: z.object({ name: z.string(), scope: SCOPE }),
      execute: async ({ name, scope }) => {
        const target = normalizeAgentName(name);
        await store.remove(principal, scope, target);
        // Cascade: the CALLER's schedules for this agent. Schedules are
        // per-principal, so an org-shared agent may still have other
        // members' schedules — surface that instead of pretending. The agent
        // is already deleted at this point, so a failing unschedule must not
        // reject the tool (the model would report a failed delete) — collect
        // and report partial failures instead.
        let removedSchedules = 0;
        const scheduleCleanupFailures: string[] = [];
        if (scheduling) {
          const mine = (await runtime.listSchedules({ principal })).filter(
            (s) => s.agent === target,
          );
          for (const s of mine) {
            try {
              await runtime.unschedule({ principal, id: s.id });
              removedSchedules++;
            } catch (error) {
              scheduleCleanupFailures.push(s.id);
              console.warn(`agent-builder: delete_agent cascade failed to unschedule ${s.id}:`, error);
            }
          }
        }
        return {
          deleted: target,
          scope,
          removedSchedules,
          ...(scheduleCleanupFailures.length
            ? {
                scheduleCleanupFailures,
                warning: `The agent is deleted, but ${scheduleCleanupFailures.length} schedule(s) could not be removed and will error on fire — retry with unschedule_agent: ${scheduleCleanupFailures.join(", ")}.`,
              }
            : {}),
          ...(scope === "org"
            ? {
                note: "Org-shared agent: other members' schedules for it (if any) are not visible here — they will error on fire until those members unschedule them.",
              }
            : {}),
        };
      },
    }),

    ...(scheduling
      ? {
          schedule_agent: tool({
            description:
              "Put an agent on a schedule: each fire sends it the prompt as a fresh, self-contained turn. Recurring via a cron expression, or one-shot (omit cron) on the next tick. Pauses for the user's approval — a schedule runs unattended and spends money.",
            inputSchema: z.object({
              agent: z.string().describe("Agent name (from list_agents)."),
              prompt: z.string().describe("The message each fire sends the agent. Self-contained — no conversation context exists at fire time."),
              cron: z
                .string()
                .optional()
                .describe('Croner expression, 5 fields or 6 with leading seconds (e.g. "0 9 * * *" = daily 9am, "*/30 * * * * *" = every 30s). Omit for a one-shot.'),
              timezone: z.string().optional().describe('IANA timezone the cron is interpreted in (e.g. "Europe/Helsinki"). Default UTC.'),
            }),
            execute: async ({ agent, prompt, cron, timezone }) => {
              try {
                const rec = await runtime.schedule({
                  principal,
                  agent: normalizeAgentName(agent),
                  prompt,
                  cron: cron ?? null,
                  timezone,
                });
                return {
                  scheduled: true,
                  id: rec.id,
                  agent: rec.agent,
                  cron: rec.cron ?? "one-shot",
                  nextRunAt: new Date(rec.nextRunAt).toISOString(),
                  note: "Manage it with list_schedules / unschedule_agent.",
                };
              } catch (e) {
                return { error: `Could not schedule: ${e instanceof Error ? e.message : String(e)}` };
              }
            },
          }),

          list_schedules: tool({
            description: "The user's scheduled agent runs (id, agent, cadence, next fire).",
            inputSchema: z.object({}),
            execute: async () => {
              const schedules = await runtime.listSchedules({ principal });
              return schedules.map((s) => ({
                id: s.id,
                agent: s.agent,
                cron: s.cron ?? "one-shot",
                timezone: s.timezone ?? "UTC",
                prompt: s.prompt,
                enabled: s.enabled,
                nextRunAt: s.enabled ? new Date(s.nextRunAt).toISOString() : null,
                lastRunAt: s.lastRunAt ? new Date(s.lastRunAt).toISOString() : null,
              }));
            },
          }),

          unschedule_agent: tool({
            description: "Remove one of the user's schedules by id (from list_schedules). Pauses for the user's approval.",
            inputSchema: z.object({ id: z.string() }),
            execute: async ({ id }) => {
              // `unschedule` returns void and silently ignores unknown ids —
              // pre-check so the result is truthful. (Lookup + delete isn't
              // atomic; the worst case of the race is a stale success for an
              // id that was concurrently deleted anyway.)
              const exists = (await runtime.listSchedules({ principal })).some((s) => s.id === id);
              if (!exists) {
                return { error: `No schedule "${id}" — check list_schedules.` };
              }
              await runtime.unschedule({ principal, id });
              return { unscheduled: id };
            },
          }),
        }
      : {}),

    test_agent: tool({
      description:
        "Run one of the user's agents once with a test message and get its answer plus which tools it called — so you can verify behavior and refine the prompt. In the default safe mode, APPROVAL-GATED tools are blocked (return a 'blocked' marker). NOTE: tools that are NOT approval-gated still execute for real — they may perform real fetch side effects (e.g. a POST). Set live=true only when the user explicitly wants a full real run.",
      inputSchema: z.object({
        name: z.string().describe("Agent name to test."),
        message: z.string().describe("The test user message to send it."),
        live: z
          .boolean()
          .optional()
          .describe("true → real run (mutating tools execute). Default false → safe (mutations blocked)."),
      }),
      execute: async ({ name, message, live }) => {
        // Normalize like every other tool — stored names are normalized.
        const target = normalizeAgentName(name);
        const { threadId, answer } = await runtime.runAgent({
          principal,
          agent: target,
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
        return decorate(extensions, "decorateTestResult", principal, target, {
          answer,
          toolCalls,
          mode: live ? "live" : "safe (mutating tools blocked)",
        });
      },
    }),

    ...extensionTools,
  };
}

/**
 * Create the Agent Builder as a standard agent factory for the host's
 * registry: `agents: { "agent-builder": createAgentBuilder({...}) }`.
 */
export function createAgentBuilder<P, RuntimeContext = unknown>(
  config: AgentBuilderConfig<P, RuntimeContext>,
): AgentFactory<P, RuntimeContext> {
  const extensions = config.extensions ?? [];
  const scheduling = config.scheduling !== false;
  const instructions = [
    buildBaseInstructions(config.capabilities ?? {}, scheduling),
    ...extensions.flatMap((e) => e.promptSections ?? []),
  ].join("\n\n");
  const subagents = [...new Set(extensions.flatMap((e) => e.subagents ?? []))];
  const toolApproval: Record<string, unknown> = {
    // Approve every persisting mutation: the user sees and confirms the exact spec.
    save_agent: "user-approval",
    delete_agent: "user-approval",
    // A schedule runs unattended and spends money; removal is destructive.
    ...(scheduling
      ? { schedule_agent: "user-approval", unschedule_agent: "user-approval" }
      : {}),
  };
  for (const ext of extensions) Object.assign(toolApproval, ext.toolApproval ?? {});

  return defineAgent<P, RuntimeContext>(
    async ({ runtime, principal }) => ({
      model:
        typeof config.model === "function"
          ? await config.model({ runtime, principal })
          : config.model,
      instructions,
      ...(subagents.length ? { subagents } : {}),
      // Host tools bound to the chatting user's principal.
      toolSources: [
        {
          async open(p: P) {
            return { tools: await builderTools(p, config), close: async () => {} };
          },
        },
      ],
      toolApproval,
      smoothStream: true,
    }),
    config.meta ?? {
      title: "Agent Builder",
      description: "Designs, creates, and updates your agents from a conversation.",
    },
  );
}
