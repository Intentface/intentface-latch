import { tool } from "ai";
import { z } from "zod";
import { defineAgent } from "@intentface/latch-core";
import type { AgentFactory, AgentMeta, Runtime, TurnWriter } from "@intentface/latch-core";
import type { LanguageModel } from "ai";
import type { AgentBuilderExtension } from "./extension";
import {
  AgentExtensionSchema,
  AgentRecordSchema,
  AgentScopeSchema,
  normalizeAgentName,
  normalizeAgentRecord,
} from "./record";
import type { AgentRecord } from "./record";
import type { AgentBuilderStore } from "./store";
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

const SCOPE = AgentScopeSchema;

/**
 * save_agent's input IS the record schema (`./record`) — the model, a host
 * editor, and a host validator all speak one shape. Capability flags live
 * under `exec.*`; host-only rules (reserved names, which flags exist here) are
 * checked in the tool below.
 */
const SAVE_INPUT = AgentRecordSchema;

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
    | "listAgents"
    | "listChats"
    | "loadHistory"
    | "runAgent"
    | "schedule"
    | "listSchedules"
    | "unschedule"
    | "previewExtension"
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
  providerWebTools?: boolean;
  renderTools?: boolean;
  defaultTools?: boolean | { description: string };
  /**
   * Whether the host honors the save-time write-approval waiver
   * (`preApprovedWrites`). Only meaningful on hosts that gate writes; a host
   * with ungated writes should declare it unsupported so the flag can't be
   * saved as a no-op.
   */
  preApprovedWrites?: boolean | { description: string };
  /**
   * Whether this host composes a memory provider (`exec.memory`). Opt-IN like
   * `preApprovedWrites`: a host without memory must not let the builder save a
   * memory config nothing will ever read.
   */
  memory?: boolean | { description: string };
  /**
   * Whether this host composes a script engine (`RuntimeConfig.scripts`) for
   * agent `extensions` — pre-turn scripts + templates. Opt-IN: without an
   * engine an extension is silently ignored, so the builder must not offer it.
   */
  extensions?: boolean | { description: string };
}

export interface AgentBuilderConfig<P, RuntimeContext = unknown> {
  /** The builder's own model — a value, or a per-request factory (e.g. per-tenant catalogs). */
  model:
    | LanguageModel
    | ((ctx: { context: RuntimeContext; principal: P }) => LanguageModel | Promise<LanguageModel>);
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
   * runtime always has the schedule API; disable if the host runs no cron
   * driver (nothing would ever fire) or supplies richer schedule tools of its
   * own via an extension. delete_agent's schedule cascade runs either way.
   */
  scheduling?: boolean;
  /** Optional feature sets: evals, tool authoring, … */
  extensions?: AgentBuilderExtension<P>[];
  /**
   * Interval (ms) for test_agent's progress heartbeat data part
   * (`data-test-agent-progress`) while the nested test run executes. The
   * heartbeat keeps idle-timeout proxies from killing the chat stream during
   * a minutes-long test and doubles as live progress. Default 10s.
   */
  testHeartbeatMs?: number;
  /** Picker metadata override. */
  meta?: AgentMeta;
}

/** The `exec` bullet, built from what the host actually supports. */
function capabilitiesBullet(support: CapabilitySupport): string {
  const offered: string[] = [];
  if (support.sandbox !== false) offered.push("sandbox (workspace + file/shell tools)");
  if (support.providerWebTools !== false) offered.push("providerWebTools (native web search/fetch)");
  if (support.renderTools !== false) offered.push("renderTools (headless-browser page render/fetch)");
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
  // Opt-in too: needs a memory provider composed into the host runtime.
  const mem = support.memory;
  if (mem) {
    offered.push(
      typeof mem === "object"
        ? `memory (${mem.description})`
        : "memory ({ scope, connection, extractTo?, schemas? } — persistent cross-session memory in one of the agent's connections; 'agent-org' needs an org-scoped agent)",
    );
  }
  const effort =
    "effort (\"minimal\" | \"low\" | \"medium\" | \"high\" — ONLY for a model where list_models shows reasoning=true; lower = faster/cheaper, higher = deeper; omit for the provider default)";
  return offered.length
    ? `- exec: capability flags, all optional — ${offered.join(", ")}, ${effort}. These are the ONLY capabilities that exist here — never promise behavior outside them (agents run as request-scoped turns; there are no persistent/background processes).`
    : `- exec: only ${effort}. No other capabilities exist in this host — never promise behavior outside the fields above.`;
}

const EXTENSIONS_PROMPT = `EXTENSIONS (the record's \`extensions\` list; test with test_extension):
An extension runs BEFORE the model on a turn: a small script fetches data through the agent's tools and a Liquid template renders it into the prompt. When the agent always needs the same data first, do NOT write "first fetch X, then Y" into the instructions — write an extension. The result is stored on the user's message, so the model reads exactly what ran.
- on: "slash" (the user types /name args → \`input.args\` is the text after the name, \`input.argv\` the words), "chat-start" (once per conversation; \`refresh: { afterMs }\` to re-run when stale), "every-turn".
- script: a JavaScript SUBSET, parsed into a plan and fully validated before it runs. Call tools by their EXACT names from list_connection_tools: \`const h = await clockify_hours({ period: input.args });\`. Pure transforms between calls (filter/map/reduce, template literals, ternaries); bounded fan-out \`await Promise.all(items.slice(0, 10).map((i) => tool({ id: i.id })))\`; try/catch around a call; end with \`return { ... }\`. NOT allowed (validation rejects with a message you can act on): loops, reassignment, \`new\`, globals, regex, network. Tool results arrive as plain values (an MCP text result that is JSON is already parsed) — read fields directly, e.g. \`h.files\`.
- template: Liquid — {{ output.field }}, {% for x in output.items %}…{% endfor %}, {% if %} — over \`input\`, \`output\` (the return value) and every \`const\` by name. Render an object or array with \`{{ output.items | json }}\` (a bare object prints as [object Object]). Blank → the output as a JSON block.
- target: "message" (default; rendered next to the user's text — \`placement\` "before"|"after") or "instructions" (system prompt; \`scope: "chat"\` keeps it for the whole conversation).
- reveal: what the user sees on their own message — "command" (default: only what they typed), "prompt" (the rendered prompt), "both".
- Read-only by default: a script calling an approval-gated (mutating) tool is refused unless \`allowMutations: true\` — leave it off unless the user asks. \`onError\`: "proceed" (default; the model is told the extension failed and continues) or "fail" (the turn errors).
- Slash names: lowercase letter first, then letters/digits/underscore; NEVER new, reset, compact, cancel, skip, status, help, commands, start (those are chat commands).
- WORKFLOW: draft the extension → test_extension with the draft (before saving; read \`rendered\`, \`calls\`, \`error\`) → fix → save_agent with the COMPLETE extensions list (it replaces the agent's previous list; get_agent shows the current one).`;

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
- instructions: the system prompt, the heart of the agent. Spend most of your effort here: role, scope, tone, which tools to use and when, and edge cases. A great agent is mostly a great prompt.
- connections: integration names from list_connections. Only wire ones that exist; prefer authorized ones. Use list_connection_tools to see what a connection offers.
${capabilitiesBullet(support)}
- subagents: names of other agents this one may delegate to.
${support.extensions ? `- extensions: pre-turn scripts + templates${typeof support.extensions === "object" ? ` (${support.extensions.description})` : ""} — see EXTENSIONS.\n` : ""}- scope: "user" (personal) or "org" (shared with the whole org).
${support.extensions ? `\n${EXTENSIONS_PROMPT}\n` : ""}${scheduling ? `\n${SCHEDULING_PROMPT}\n` : ""}
WORKFLOW:
1. Understand the goal. If it's vague, ask a few sharp questions first (purpose, behavior, integrations, tone).${
    support.extensions
      ? `
   LISTEN FOR DATA THE AGENT ALWAYS NEEDS FIRST. "Start every chat by fetching…", "first look up X, then…", a daily/weekly report, a briefing, "summarise yesterday's…", "/something" — those are EXTENSIONS, not instructions: a script fetches the data before the model runs and a template renders it into the prompt. Propose one (say which trigger and why) rather than writing "first fetch X" into the system prompt, which is slow and unreliable. Repeatable reports become slash commands; per-conversation context becomes chat-start; live state becomes every-turn.`
      : ""
  }
2. Discover before proposing: call list_models and list_connections (and list_connection_tools for any you'll wire).
3. ALWAYS ask whether the agent should be personal (user) or org-shared before saving — scope is required and you must not guess it.
4. Propose: summarize the agent in plain language (name, model, connections, key instruction points) and get a quick confirmation.
5. Call save_agent. It pauses for the user's approval — they'll see the full spec; that's expected.${
    support.extensions
      ? ` If the agent has extensions, draft and test_extension them BEFORE this save (an existing agent) or right after the first save (a new one — the tools come from its saved connections), then save_agent again with the extensions attached.`
      : ""
  }
6. TEST IT: after saving, offer to test_agent with a realistic message. Read the answer + tool calls it returns, and tell the user how it did. If it's off (wrong tone, missed a tool, weak reasoning), refine the instructions and save_agent again, then re-test — iterate until it's good. test_agent blocks mutating tools by default (no real side effects); only pass live=true if the user explicitly wants a real end-to-end run.
7. Confirm it's ready and that they can pick it from the agent list.

MODIFYING an existing agent: call get_agent first, change only what's needed, then save_agent with the SAME name and scope. Re-test with test_agent to confirm the change had the intended effect.${
    support.extensions
      ? ` When the user wants a better template, a different trigger, or asks why an extension shows odd output, get_agent shows the extension; run test_extension by name to see its real output and rendered text, fix, then save_agent with the COMPLETE extensions list.`
      : ""
  }

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
  const unsupportedCapabilities = (exec: AgentRecord["exec"]): string[] => {
    const asked: [string, unknown, boolean][] = [
      ["sandbox", exec?.sandbox, support.sandbox !== false],
      ["providerWebTools", exec?.providerWebTools, support.providerWebTools !== false],
      ["renderTools", exec?.renderTools, support.renderTools !== false],
      ["defaultTools", exec?.defaultTools, support.defaultTools !== false],
      // Opt-in (see capabilitiesBullet): unsupported unless declared.
      ["preApprovedWrites", exec?.preApprovedWrites, !!support.preApprovedWrites],
      ["memory", exec?.memory, !!support.memory],
    ];
    return asked.filter(([, on, ok]) => on && !ok).map(([name]) => name);
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
            exec: r.exec,
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
      execute: async (raw) => {
        // Re-validate here as well as at the SDK boundary: it applies the
        // schema's defaults and the host-independent invariants (memory
        // connection wired, agent-org ⇒ org scope, index outlines) even when a
        // host calls the tool directly, and reports violations as a tool
        // error the model can act on instead of a thrown ZodError.
        const parsed = SAVE_INPUT.safeParse(raw);
        if (!parsed.success) {
          return {
            error: `Invalid agent: ${parsed.error.issues.map((i) => `${i.path.join(".") || "record"}: ${i.message}`).join("; ")}`,
          };
        }
        // Canonicalize, then apply THIS host's policy.
        const rec = normalizeAgentRecord(parsed.data);
        const name = rec.name;
        if (!name) return { error: "invalid name" };
        if (reserved.has(name)) {
          return { error: `"${name}" is a built-in agent and can't be overwritten — pick another name.` };
        }
        if (!models.some((m) => m.id === rec.modelId)) {
          return { error: `Unknown modelId "${rec.modelId}". Call list_models and use one of those.` };
        }
        // `effort` is a no-op on non-reasoning models — reject like the
        // capability flags instead of persisting a setting that does nothing.
        if (rec.exec?.effort && !models.find((m) => m.id === rec.modelId)?.reasoning) {
          return {
            error: `Model "${rec.modelId}" is not reasoning-capable (list_models shows reasoning=false) — omit exec.effort or pick a reasoning model.`,
          };
        }
        // Reject hallucinated references — only names the discovery tools return.
        const knownConnections = new Set((await listConnections(principal)).map((c) => c.name));
        const badConn = rec.connections.filter((n) => !knownConnections.has(n));
        if (badConn.length) {
          return { error: `Unknown connection(s): ${badConn.join(", ")}. Use list_connections.` };
        }
        const knownAgents = new Set((await runtime.listAgents(principal)).map((a) => a.name));
        const badSub = (rec.subagents ?? []).filter((n) => !knownAgents.has(n) && n !== name);
        if (badSub.length) {
          return { error: `Unknown subagent(s): ${badSub.join(", ")}. Use list_agents.` };
        }
        // Authored tools only exist where an extension provides them — a clear
        // rejection beats silently dropping a capability the model asked for.
        if (rec.exec?.authoredTools?.length && !authoredToolsSupported) {
          return { error: "Tool authoring is not available here — omit exec.authoredTools." };
        }
        // Extensions need a script engine on the host — same rule as above.
        if (rec.extensions?.length && !support.extensions) {
          return { error: "Not available in this host: extensions. Omit them — and don't promise the user pre-turn scripts." };
        }
        // Same for capability flags the host never wired: rejecting beats
        // persisting a silent no-op the user believes in.
        const unsupported = unsupportedCapabilities(rec.exec);
        if (unsupported.length) {
          return {
            error: `Not available in this host: ${unsupported.join(", ")}. Omit ${unsupported.length > 1 ? "them" : "it"} — and don't promise the user that behavior.`,
          };
        }
        // The write waiver without write tools is meaningless — likely a
        // misunderstanding worth surfacing rather than persisting.
        if (rec.exec?.preApprovedWrites && !rec.exec?.defaultTools) {
          return {
            error: "exec.preApprovedWrites requires exec.defaultTools (the write capability) — there are no writes to waive without it.",
          };
        }
        // The builder speaks the record's model-facing fields. Per-tool
        // selections (`tools`) and attached evals are managed by other
        // surfaces (an editor, an evals feature) — carry them over when the
        // input doesn't mention them, so a save never silently detaches them.
        // Pinned to the record's own scope: a same-named agent in the other
        // scope must not donate its state.
        const existing = await store.getRecord(principal, `${rec.scope}:${name}`);
        const merged: AgentRecord = {
          ...rec,
          tools: rec.tools ?? existing?.tools,
          attachedEvals: rec.attachedEvals ?? existing?.attachedEvals,
        };
        // Extension vetoes (e.g. tool-authoring existence + org-scope rules).
        for (const ext of extensions) {
          const veto = await ext.validateSave?.(principal, merged);
          if (veto) return { error: veto };
        }
        await store.upsert(principal, merged);
        return decorate(extensions, "decorateSaveResult", principal, name, {
          saved: true,
          name,
          scope: rec.scope,
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
        // Cascade: the CALLER's schedules for this agent — regardless of
        // whether THIS builder offers schedule tools (`scheduling`): schedules
        // can exist from other surfaces, and an orphan errors on every tick.
        // Schedules are per-principal, so an org-shared agent may still have
        // other members' schedules — surface that instead of pretending. The
        // agent is already deleted at this point, so a failing unschedule must
        // not reject the tool (the model would report a failed delete) —
        // collect and report partial failures instead.
        let removedSchedules = 0;
        const scheduleCleanupFailures: string[] = [];
        let mine: { id: string }[] = [];
        let listFailed = false;
        try {
          mine = (await runtime.listSchedules({ principal })).filter((s) => s.agent === target);
        } catch (error) {
          listFailed = true;
          console.warn(`agent-builder: delete_agent could not list schedules for ${target}:`, error);
        }
        for (const s of mine) {
          try {
            await runtime.unschedule({ principal, id: s.id });
            removedSchedules++;
          } catch (error) {
            scheduleCleanupFailures.push(s.id);
            console.warn(`agent-builder: delete_agent cascade failed to unschedule ${s.id}:`, error);
          }
        }
        return {
          deleted: target,
          scope,
          removedSchedules,
          ...(listFailed
            ? {
                warning:
                  "The agent is deleted, but its schedules could not be listed — check list_schedules and remove any that still name it.",
              }
            : {}),
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
        "Run one of the user's agents once with a test message and get its answer plus which tools it called — so you can verify behavior and refine the prompt. In the default safe mode, APPROVAL-GATED tools are blocked (return a 'blocked' marker). NOTE: tools that are NOT approval-gated still execute for real — they may perform real fetch side effects (e.g. a POST). Set live=true only when the user explicitly wants a full real run. A web-heavy agent's test can take MINUTES (each fetch is a full page read) — warn the user before testing one.",
      inputSchema: z.object({
        name: z.string().describe("Agent name to test."),
        message: z.string().describe("The test user message to send it."),
        live: z
          .boolean()
          .optional()
          .describe("true → real run (mutating tools execute). Default false → safe (mutations blocked)."),
      }),
      execute: async ({ name, message, live }, options) => {
        // Normalize like every other tool — stored names are normalized.
        const target = normalizeAgentName(name);
        // The nested run is one long, otherwise-SILENT await inside this
        // turn — minutes for a web-heavy agent. Emit a small heartbeat data
        // part on an interval: it keeps idle-timeout proxies from killing
        // the chat stream, and gives the user live progress instead of dead
        // air. Reconciled in place by id (one part, updated), like
        // latch-platform's eval progress card.
        const env = (options ?? {}) as {
          toolCallId?: string;
          context?: { writer?: TurnWriter };
        };
        const startedAt = Date.now();
        const writeHeartbeat = () => {
          env.context?.writer?.write({
            type: "data-test-agent-progress",
            id: `testprog_${env.toolCallId ?? "run"}`,
            data: {
              toolCallId: env.toolCallId,
              agent: target,
              elapsedSec: Math.round((Date.now() - startedAt) / 1000),
            },
          });
        };
        // Guard the configured cadence: 0/negative/NaN would spin the writer.
        const cadence =
          Number.isFinite(config.testHeartbeatMs) && (config.testHeartbeatMs as number) >= 10
            ? (config.testHeartbeatMs as number)
            : 10_000;
        const heartbeat = setInterval(writeHeartbeat, cadence);
        let threadId: string;
        let answer: string;
        try {
          writeHeartbeat();
          ({ threadId, answer } = await runtime.runAgent({
            principal,
            agent: target,
            prompt: message,
            blockGated: !live,
          }));
        } catch (error) {
          // Surface the REAL failure — a generic tool error invites the
          // model to confabulate reassuring explanations.
          return {
            error: `test run of "${target}" failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        } finally {
          clearInterval(heartbeat);
        }
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

    ...(support.extensions
      ? {
          test_extension: tool({
            description:
              "Run ONE extension (a DRAFT you pass inline, or a saved one by name) over an existing agent's live tools — no model call, nothing persisted — and get what the model would have seen: `rendered`, the `calls` it made, `output`, or the `error` (validation, gated tool, tool failure). Use it to iterate on a draft BEFORE save_agent. For a slash extension pass `text` like the user would type it (\"/report week\").",
            inputSchema: z.object({
              agent: z.string().describe("An existing agent whose tools the script runs over."),
              extension: AgentExtensionSchema.optional().describe("The draft to run (preferred while iterating)."),
              name: z.string().optional().describe("Or: a saved extension's name on that agent."),
              text: z.string().optional().describe("For slash extensions: the invocation as typed, e.g. \"/report week\"."),
              input: z.json().optional().describe("Structured input instead of `text`."),
            }),
            execute: async ({ agent, extension, name, text, input }) => {
              if (!extension && !name) return { error: "Pass a draft `extension` or a saved `name`." };
              try {
                const part = await runtime.previewExtension({
                  agent: normalizeAgentName(agent),
                  principal,
                  extension,
                  name,
                  text,
                  input,
                });
                return {
                  rendered: part.rendered,
                  calls: part.calls.map((c) => c.tool),
                  output: part.output,
                  files: (part.files ?? []).map((f) => f.filename ?? f.mediaType),
                  durationMs: part.durationMs,
                  ...(part.error ? { error: part.error } : {}),
                  note: part.error
                    ? "Fix the script/template and test again."
                    : "This is what the model would read. Save it with save_agent (full extensions list).",
                };
              } catch (error) {
                return { error: error instanceof Error ? error.message : String(error) };
              }
            },
          }),
        }
      : {}),

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
    async ({ context, principal }) => ({
      model:
        typeof config.model === "function"
          ? await config.model({ context, principal })
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
