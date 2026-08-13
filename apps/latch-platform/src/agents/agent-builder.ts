import { anthropic } from "@ai-sdk/anthropic";
import { tool } from "ai";
import { z } from "zod";
import { defineAgent } from "@intentface/latch-core";
import type { Principal } from "@/lib/session";
import {  normalizeAgentName } from "@/lib/agent-store";
import type {AgentRecord} from "@/lib/agent-store";
import { validateRubrics } from "@/lib/observability/rubrics";
import { isOrgAdmin } from "@/lib/auth";
import { secretDependents, secretKey } from "@/lib/connection-store";
import { upsertConnection, normalizeConnectionName } from "@/lib/connection-upsert";
import type { ConnectionInput } from "@/lib/connection-upsert";
import type { ScheduleDelivery } from "@/lib/schedule-delivery";
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
    defaultTools: z.boolean().optional().describe("App harness tools: web_fetch, askUser, and self-scheduling (create/list/cancel_schedule)."),
    memory: z
      .object({
        scope: z
          .enum(["agent-user", "agent-org", "user"])
          .describe(
            "'agent-user' = this agent's memory of each user (default choice); 'agent-org' = one shared memory for the whole org (requires the agent itself to have scope 'org'); 'user' = shared across all the user's agents.",
          ),
        connection: z
          .string()
          .min(1)
          .describe("Which of the agent's connections holds the memory files (must be in `connections`; typically 'loredex')."),
        extractTo: z
          .array(z.enum(["agent-user", "agent-org", "user"]))
          .optional()
          .describe(
            "EXTRA memory levels the background archivist also files facts into from the same conversations (the primary scope is always included). 'agent-org' here also requires the agent to have scope 'org'. Same connection for all levels.",
          ),
        schemas: z
          .object({
            "agent-user": z.string().optional(),
            "agent-org": z.string().optional(),
          })
          .optional()
          .describe(
            "Markdown index-schema outlines per agent-held level ('## Section' headings + description bullets): what that level collects and how its MEMORY.md is organized. Draft them with generate_memory_schemas. The shared 'user' level's schema is a workspace file — save it with save_user_memory_schema instead.",
          ),
      })
      .optional()
      .describe(
        "Persistent cross-session memory: the platform archives durable facts from idle chats into the connection's workspace, injects a compiled index each turn, and adds memory_search/memory_save tools.",
      ),
  })
  .optional();

/**
 * One field on the secret form. `secret: true` means the value is written
 * straight from the browser into the Vault under `name` and NEVER comes back to
 * the model — the agent gets the name and passes it as a `*Ref`. `secret: false`
 * is an ordinary value (a client id, an account slug) returned in the result.
 */
const SECRET_FIELD = z.object({
  key: z
    .string()
    .min(1)
    .describe('Identifier for this field in the result, e.g. "clientId".'),
  label: z.string().min(1).describe('Shown above the input, e.g. "Client Secret".'),
  secret: z
    .boolean()
    .describe(
      "true = the value is stored in the Vault and you only ever see its name. false = a plain value returned to you.",
    ),
  name: z
    .string()
    .optional()
    .describe(
      'Vault name for a secret field, e.g. "strava_client_secret". REQUIRED when secret is true — this is the handle you pass to create_connection as clientSecretRef/tokenRef.',
    ),
  hint: z
    .string()
    .optional()
    .describe("One short line telling the user where to find this value."),
});

const REQUEST_SECRET_INPUT = z.object({
  title: z.string().min(1).describe('Heading for the form, e.g. "Strava API credentials".'),
  scope: SCOPE.describe(
    "Where the secrets are stored. Must match the scope of the connection they will back. 'org' requires the user to be an org admin.",
  ),
  fields: z.array(SECRET_FIELD).min(1).max(6),
});

/**
 * `create_connection`'s input — the connection record, with `*Ref` vault names
 * standing in for the two secret-bearing fields. A raw secret must never appear
 * here: the input is echoed verbatim on the approval card and into the model's
 * own context.
 */
const CREATE_CONNECTION_INPUT = z.object({
  name: z.string().min(1).describe("Connection id, kebab/snake case (e.g. \"strava\")."),
  kind: z.enum(["mcp", "openapi"]),
  scope: SCOPE.describe("'user' (personal) or 'org' (shared). Never guess — ask."),
  url: z.string().optional().describe("MCP only: the server URL."),
  spec: z.string().optional().describe("OpenAPI only: the spec URL (or inline spec)."),
  baseUrl: z.string().optional().describe("OpenAPI only: override the spec's server URL."),
  operations: z
    .string()
    .optional()
    .describe("OpenAPI only: comma-separated operationId allow-list. Omit for all."),
  authMode: z
    .enum(["none", "token", "oauth", "oauth2"])
    .optional()
    .describe(
      "'none'; 'token' = static bearer/header (needs tokenRef); 'oauth' = MCP discovery flow (no credentials); 'oauth2' = OpenAPI pre-registered client (needs authorizeUrl, tokenUrl, clientId, clientSecretRef).",
    ),
  authHeader: z
    .string()
    .optional()
    .describe('Header name for a static token when it is not "Authorization: Bearer".'),
  tokenRef: z
    .string()
    .optional()
    .describe("Vault name of the static token, from request_secret. Omit on edit to keep the stored one."),
  authorizeUrl: z.string().optional(),
  tokenUrl: z.string().optional(),
  clientId: z.string().optional().describe("Not a secret — pass the value directly."),
  clientSecretRef: z
    .string()
    .optional()
    .describe("Vault name of the oauth2 client secret, from request_secret. Omit on edit to keep the stored one."),
  scopes: z
    .string()
    .optional()
    .describe("Whitespace-separated scope items (a provider's own commas survive inside one item)."),
});

/**
 * The service-free save_agent preflight: name reservations + the memory-config
 * invariants. Returns the rejection message, or undefined to proceed. Exported
 * (with SAVE_INPUT) so the guards are regression-testable without standing up
 * the live service bundle; the service-backed checks (models, connections,
 * subagents, tools) stay inline in the tool.
 */
export function saveAgentPreflight(input: {
  name: string;
  scope: "user" | "org";
  connections?: string[];
  capabilities?: {
    memory?: {
      scope: string;
      connection: string;
      extractTo?: string[];
      schemas?: Record<string, string | undefined>;
    };
  };
}): string | undefined {
  const name = normalizeAgentName(input.name);
  if (!name) return "invalid name";
  if (RESERVED_NAMES.has(name)) {
    return `"${name}" is a built-in agent and can't be overwritten — pick another name.`;
  }
  // The whole memory-* prefix is reserved: the platform's memory system
  // agents live there and pickers hide every name matching it.
  if (name.startsWith("memory-")) {
    return `"${name}" is reserved (memory-* are platform system agents) — pick another name.`;
  }
  // Memory files live in one of the agent's OWN connections. `!== undefined`
  // (not truthy): an empty string must fail the membership check, not skip it.
  const mem = input.capabilities?.memory;
  const memConn = mem?.connection;
  if (memConn !== undefined && !(input.connections ?? []).includes(memConn)) {
    return `Memory connection "${memConn}" must also be listed in the agent's connections.`;
  }
  // agent-org memory is keyed by agent name alone — restrict it to
  // org-visible agents so same-named personal agents can't share a store.
  // Applies to the primary scope AND every extraction level.
  const levels = [mem?.scope, ...(mem?.extractTo ?? [])].filter((l): l is string => l != null);
  if (levels.includes("agent-org") && input.scope !== "org") {
    return `Org-shared memory ('agent-org') requires scope: "org" on the agent itself.`;
  }
  // Index schemas: agent-held levels only, and each must be a real outline —
  // at least one "## Section" heading (that outline IS the schema).
  for (const [level, schema] of Object.entries(mem?.schemas ?? {})) {
    if (schema == null || !schema.trim()) continue;
    if (level !== "agent-user" && level !== "agent-org") {
      return `Memory schemas are per agent-held level (agent-user, agent-org) — the shared 'user' schema is saved with save_user_memory_schema.`;
    }
    if (schema.length > 4000) {
      return `Memory schema for ${level} is too long (max 4000 chars).`;
    }
    if (!/^\s*##(?!#)\s*\S/m.test(schema)) {
      return `Memory schema for ${level} needs at least one "## Section" heading.`;
    }
  }
  return undefined;
}

// Exported for schema regression tests only.
export const SAVE_INPUT = z.object({
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
  trigger: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'WHEN the judge runs — a structural predicate tree; omit to judge every turn. Leaves: {"kind":"turn","eq"|"gte"|"lte"|"everyNth":N} (1-based turn # in the chat; everyNth matches turns N, 2N, …), {"kind":"toolCalled","name"?:string}, {"kind":"depth","eq"|"gte"|"lte":N} (0 = top-level; mentioning depth is the ONLY way to judge subagent turns), {"kind":"chatKind","is":"user"|"internal"}. Combinators: {"kind":"all"|"any","of":[…]}, {"kind":"not","of":…}. E.g. greet-on-first-message → {"kind":"turn","eq":1}.',
    ),
  context: z
    .enum(["turn", "chat", "loop"])
    .optional()
    .describe(
      "WHAT the judge sees: turn (default: last user msg + final answer + tool-name summary), chat (plus the conversation so far), loop (this turn full-fidelity: all assistant text + tool calls WITH outputs, subagents as one-line summaries).",
    ),
});

/** Build the management toolset bound to one Principal + the live Latch services. */
async function builderTools(principal: Principal): Promise<Record<string, unknown>> {
  // Lazy import avoids a static import cycle (latch.ts → agents → here).
  const { getLatch } = await import("@/lib/latch");
  const { runtime, agentStore, allConnections, connections, connectionStore, dynamic, models, authoredTools, evalStore, namedSecrets, memoryStore } =
    await getLatch();

  /** Org-scoped connections and secrets are admin-managed — same gate as the UI. */
  const orgAdminOk = async (scope: "user" | "org") =>
    scope !== "org" || (await isOrgAdmin(principal.userId!, principal.orgId));

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
      memory: c?.memory ?? undefined,
    };
    const hasAny =
      !!c?.sandbox ||
      !!c?.defaultTools ||
      !!c?.providerWebTools ||
      !!c?.codeMode ||
      !!authored?.length ||
      effort !== undefined ||
      !!c?.memory;
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

    list_secrets: tool({
      description:
        "Credentials the user has already stored, by NAME and scope only (values are never readable), with the connections each one currently backs. Pass a name to create_connection as clientSecretRef/tokenRef — reusing one is how two connections share a credential.",
      inputSchema: z.object({}),
      execute: async () => {
        const [secrets, conns] = await Promise.all([
          namedSecrets.list(principal),
          connectionStore.list(principal),
        ]);
        const dependents = secretDependents(conns);
        return secrets.map((s) => ({
          ...s,
          usedBy: dependents.get(secretKey(s.scope, s.name)) ?? [],
        }));
      },
    }),

    // No `execute` — this is client-handled. The turn pauses at
    // `input-available`, the composer renders the form, the browser posts the
    // values straight to `saveSecretsFn`, and the run resumes with a result
    // holding only names + non-secret values. The plaintext never enters a tool
    // input, a tool output, or the message history.
    request_secret: tool({
      description:
        "Ask the user to type credentials into a secure form. Secret fields go straight to the Vault and come back to you as NAMES only; non-secret fields come back as values. Use this for every API key, client secret and token — never ask for one in chat.",
      inputSchema: REQUEST_SECRET_INPUT,
    }),

    create_connection: tool({
      description:
        "Create or update an integration the user's agents can call (upsert by name + scope). Secrets are passed as vault names from request_secret, never as values. Pauses for the user's approval.",
      inputSchema: CREATE_CONNECTION_INPUT,
      execute: async (input) => {
        if (!(await orgAdminOk(input.scope))) {
          return { error: "Only org admins can manage org-shared connections." };
        }
        for (const field of ["clientSecret", "token"] as const) {
          if (field in input) {
            return {
              error: `Pass ${field}Ref (a vault name from request_secret), not ${field}. Raw secrets are not accepted here.`,
            };
          }
        }

        // The refs go into the record as NAMES. Nothing on this path reads a
        // secret's value — `upsertConnection` checks the names exist at this
        // scope, and the plaintext is fetched only at egress.
        const record: ConnectionInput = {
          name: input.name,
          kind: input.kind,
          scope: input.scope,
          url: input.url,
          spec: input.spec,
          baseUrl: input.baseUrl,
          operations: input.operations,
          authMode: input.authMode,
          authHeader: input.authHeader,
          tokenRef: input.tokenRef,
          authorizeUrl: input.authorizeUrl,
          tokenUrl: input.tokenUrl,
          clientId: input.clientId,
          clientSecretRef: input.clientSecretRef,
          scopes: input.scopes,
        };
        const saved = await upsertConnection(principal, record, {
          connectionStore,
          dynamic,
          namedSecrets,
        });
        if (!saved.ok) return { error: saved.error };
        console.log(
          `[connections] upsert name=${saved.name} scope=${input.scope} kind=${input.kind} by=${principal.userId ?? "-"}@${principal.orgId} via=agent-builder`,
        );

        // Open it for real so a bad spec URL or an unreachable MCP server is a
        // fixable error now, not a mystery when the agent runs.
        const interactive = input.authMode === "oauth" || input.authMode === "oauth2";
        try {
          const tools = await dynamic.testTools(saved.name, principal);
          return {
            saved: true,
            name: saved.name,
            scope: input.scope,
            tools,
            note:
              tools.length === 0 && interactive
                ? `Not authorized yet — call connect_connection({ name: "${saved.name}" }) so the user can grant access, then re-check with list_connection_tools.`
                : tools.length === 0
                  ? "The connection opened but exposed no tools — check the spec URL or the operations allow-list."
                  : undefined,
          };
        } catch (e) {
          return {
            saved: true,
            name: saved.name,
            scope: input.scope,
            tools: [],
            warning: `Saved, but opening it failed: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      },
    }),

    connect_connection: tool({
      description:
        "Ask the user to authorize an OAuth connection. They'll approve, sign in with the provider, and this conversation resumes automatically. Only for connections whose authMode is 'oauth' or 'oauth2'.",
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: async ({ name }) => ({ connected: true, connection: name }),
    }),

    delete_connection: tool({
      description: "Delete a connection at its scope. Destructive — pauses for approval.",
      inputSchema: z.object({ name: z.string().min(1), scope: SCOPE }),
      execute: async ({ name, scope }) => {
        if (!(await orgAdminOk(scope))) {
          return { error: "Only org admins can manage org-shared connections." };
        }
        const target = normalizeConnectionName(name);
        await connectionStore.remove(principal, scope, target);
        console.log(
          `[connections] delete name=${target} scope=${scope} by=${principal.userId ?? "-"}@${principal.orgId} via=agent-builder`,
        );
        return { deleted: true, name: target, scope };
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
        const rejected = saveAgentPreflight(input);
        if (rejected) return { error: rejected };
        const name = normalizeAgentName(input.name);
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

    // ── Memory schemas ──────────────────────────────────────────────────────

    generate_memory_schemas: tool({
      description:
        "Draft memory index schemas (markdown '## Section' outlines) for an agent from its " +
        "instructions — one per requested level. Pure generation, nothing persists: attach the " +
        "agent-held levels via save_agent's capabilities.memory.schemas after the user approves " +
        "them; a 'user'-level draft is saved with save_user_memory_schema instead.",
      inputSchema: z.object({
        name: z.string().describe("The agent's name (context for the drafts)."),
        instructions: z.string().min(1).describe("The agent's system prompt to derive the schemas from."),
        levels: z
          .array(z.enum(["agent-user", "agent-org", "user"]))
          .min(1)
          .describe("Which memory levels to draft schemas for."),
      }),
      execute: async ({ name, instructions, levels }) => {
        const { buildSchemaGenerationPrompt } = await import("@/lib/memory/schema-generation");
        const { generateText } = await import("ai");
        const schemas: Record<string, string> = {};
        for (const level of Array.from(new Set(levels))) {
          const { text } = await generateText({
            model: anthropic("claude-sonnet-4-6"),
            ...buildSchemaGenerationPrompt({ agent: name, instructions, level }),
          });
          const fenced = /```(?:markdown|md)?\n([\s\S]*?)```/.exec(text);
          schemas[level] = (fenced?.[1] ?? text).trim();
        }
        return {
          schemas,
          note:
            "Show these to the user and apply their edits. Attach agent-user/agent-org via " +
            "save_agent capabilities.memory.schemas; save a 'user' draft with save_user_memory_schema.",
        };
      },
    }),

    save_user_memory_schema: tool({
      description:
        "Save the ORG-WIDE user-level memory schema — one shared workspace file " +
        "(__shared_root/_memory/_user/SCHEMA.md) governing what EVERY agent's background archivist files into " +
        "users' cross-agent profiles. Affects all memory-enabled agents on the connection — " +
        "pauses for the user's approval.",
      inputSchema: z.object({
        connection: z
          .string()
          .default("loredex")
          .describe("The memory connection whose workspace holds the file (default 'loredex')."),
        schema: z
          .string()
          .min(1)
          .describe("The complete schema markdown ('## Section' headings + description bullets)."),
      }),
      execute: async ({ connection, schema }) => {
        // Org-wide memory policy — admin-gated like create/delete_connection
        // (the approval pause alone still lets any member approve their own ask).
        if (!(await isOrgAdmin(principal.userId!, principal.orgId))) {
          return { error: "only an org admin can edit the shared user schema" };
        }
        if (schema.length > 4000) return { error: "schema too long (max 4000 chars)" };
        if (!/^\s*##(?!#)\s*\S/m.test(schema)) {
          return { error: 'the schema needs at least one "## Section" heading' };
        }
        const { USER_SCHEMA_PATH } = await import("@intentface/latch-memory");
        try {
          await memoryStore.writeFile(principal, {
            connection,
            path: USER_SCHEMA_PATH,
            content: schema.endsWith("\n") ? schema : `${schema}\n`,
            summary: "Shared user-memory index schema (all agents, user level)",
          });
          return { saved: true, path: USER_SCHEMA_PATH, connection };
        } catch (error) {
          return { error: `could not write the schema file: ${String(error)}` };
        }
      },
    }),

    // ── Schedules ───────────────────────────────────────────────────────────
    // The builder can schedule ANY of the user's agents, unlike the harness
    // `create_schedule` (which only ever schedules the agent it's running as).
    // That's also why this is the one place a delivery target is named by the
    // model: this is a web chat, so there's no channel to derive one from.
    // It's safe because every target is checked against `list_agent_channels`
    // and then re-checked by `resolveDelivery` — and the whole call pauses for
    // approval with the spec echoed on the card.

    list_agent_channels: tool({
      description:
        "The channels a scheduled run of this agent could be delivered to — the Telegram bots " +
        "the user has linked and the Slack apps they own, with each app's channels. Call this " +
        "before create_agent_schedule; deliverTo values not listed here are rejected.",
      inputSchema: z.object({ agent: z.string().describe("Agent name from list_agents.") }),
      execute: async ({ agent }) => {
        const { listAgentChannels, deliveryOptions } = await import("@/lib/schedule-delivery");
        const channels = deliveryOptions(await listAgentChannels(principal, agent));
        // Count the ENTRIES, not the apps: a Slack app whose channels couldn't
        // be listed (missing token or scope) yields no entries, and without this
        // the model would get an empty list and no explanation for it.
        return {
          channels,
          note:
            channels.length === 0
              ? "No channels available — a schedule for this agent will run in the app only."
              : undefined,
        };
      },
    }),

    create_agent_schedule: tool({
      description:
        "Schedule one of the user's agents to run on a cron expression (omit `cron` for a " +
        "one-off on the next tick), optionally delivering each run into a channel. Pauses for " +
        "the user's approval.",
      inputSchema: z.object({
        agent: z.string().describe("Agent name from list_agents."),
        cron: z
          .string()
          .optional()
          .describe("5-field cron, e.g. `0 8 * * 1-5`. Omit for a one-off run."),
        timezone: z
          .string()
          .optional()
          .describe("IANA timezone the cron is read in, e.g. `Europe/Helsinki`. Defaults to UTC."),
        prompt: z.string().describe("The message the agent receives on each fire."),
        deliverTo: z
          .object({
            kind: z.enum(["telegram", "slack"]),
            ref: z.string().describe("The `ref` from list_agent_channels (bot id / Slack app id)."),
            channel: z
              .string()
              .optional()
              .describe("Slack only: the channel id from list_agent_channels."),
          })
          .optional()
          .describe("Omit to run in the app only (no channel push)."),
      }),
      execute: async ({ agent, cron, timezone, prompt, deliverTo }) => {
        const { resolveOfferedDelivery, DeliveryError } = await import("@/lib/schedule-delivery");
        const { checkScheduleLimits } = await import("@/lib/schedule-limits");
        // The same cap and frequency floor the harness `create_schedule`
        // applies. Both are model-driven, so both need them — the builder is
        // if anything the wider surface, since it can schedule ANY agent.
        const rejected = await checkScheduleLimits(
          runtime,
          principal,
          cron?.trim() || null,
          timezone,
        );
        if (rejected) return { error: rejected };

        let delivery: ScheduleDelivery | undefined;
        let deliversTo = "app only";
        if (deliverTo) {
          // Rejects hallucinated references (only what discovery returned) and
          // re-checks the entitlement — the same guard the harness
          // `create_schedule` uses for its own `deliver_to`.
          try {
            const offered = await resolveOfferedDelivery(principal, agent, deliverTo);
            if (!offered) {
              return {
                error: `Unknown channel for agent "${agent}". Use list_agent_channels and pass one of its entries.`,
              };
            }
            delivery = offered.delivery;
            deliversTo = offered.label;
          } catch (e) {
            return {
              error: e instanceof DeliveryError ? e.message : "Delivery target rejected.",
            };
          }
        }
        try {
          const created = await runtime.schedule({
            principal,
            agent,
            cron: cron?.trim() || null,
            timezone,
            prompt,
            delivery,
          });
          return {
            id: created.id,
            agent: created.agent,
            cron: created.cron ?? "one-off",
            timezone: created.timezone ?? "UTC",
            nextRunAt: new Date(created.nextRunAt).toISOString(),
            deliversTo,
          };
        } catch (e) {
          return { error: e instanceof Error ? e.message : "Failed to create the schedule." };
        }
      },
    }),

    list_agent_schedules: tool({
      description: "The user's scheduled runs, optionally filtered to one agent.",
      inputSchema: z.object({ agent: z.string().optional() }),
      execute: async ({ agent }) => {
        const all = await runtime.listSchedules({ principal });
        const { parseAgentRef } = await import("@/lib/agent-store");
        const wanted = agent ? parseAgentRef(agent).name : undefined;
        return {
          schedules: all
            .filter((s) => !wanted || parseAgentRef(s.agent).name === wanted)
            .map((s) => ({
              id: s.id,
              agent: s.agent,
              cron: s.cron ?? "one-off",
              timezone: s.timezone ?? "UTC",
              prompt: s.prompt,
              enabled: s.enabled,
              nextRunAt: new Date(s.nextRunAt).toISOString(),
            })),
        };
      },
    }),

    delete_agent_schedule: tool({
      description:
        "Delete one of the user's scheduled runs by id (from list_agent_schedules). " +
        "Pauses for the user's approval.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        // `unschedule` is owner-fenced and returns void, so a foreign or stale
        // id deletes nothing silently. Confirm it's the caller's first —
        // otherwise this reports a deletion that never happened.
        const mine = await runtime.listSchedules({ principal });
        if (!mine.some((s) => s.id === id)) {
          return { error: `No schedule ${id} — call list_agent_schedules for current ids.` };
        }
        await runtime.unschedule({ principal, id });
        return { deleted: id };
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
        "Attach ONLINE evals to an agent: LLM-judge rubrics that run automatically on live runs — every top-level turn by default, or only the turns a rubric's `trigger` selects — pushing verdicts to Langfuse as scores the user watches on the Observability page. REPLACES the agent's current attached evals (pass the full list). Pauses for the user's approval.",
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
        // `trigger` arrives as loose JSON — validateRubrics runs the real AST
        // validation (validateTrigger) and rejects malformed trees with a
        // message the model can act on.
        const valid = validateRubrics(
          evals as unknown as Parameters<typeof validateRubrics>[0],
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
- connections: integration names from list_connections. Only wire ones that exist; prefer authorized ones. Use list_connection_tools to see what a connection offers. If the one the agent needs doesn't exist yet, you can create it — see CREATING A CONNECTION.
- capabilities: codeMode (writes/runs JS over its tools — multi-step orchestration), sandbox (workspace + file/shell tools), providerWebTools (native web search/fetch), defaultTools (web_fetch + askUser), memory (see MEMORY & SCHEMAS).
- authoredTools: names of custom tools you've authored (see BUILDING TOOLS) for this agent to call.
- subagents: names of other agents this one may delegate to.
- scope: "user" (personal) or "org" (shared with the whole org).

MEMORY & SCHEMAS (capabilities.memory + generate_memory_schemas / save_user_memory_schema):
An agent with capabilities.memory remembers across sessions: the platform archives durable facts from idle chats in the background, injects a compiled index (MEMORY.md) each turn, and adds memory_search/memory_save. Memory has LEVELS, each a separate store with its own audience:
- "agent-user" — this agent's private memory of each user (the default primary scope).
- "agent-org" — one store shared by the whole org (requires the agent's scope to be "org"). Policy floor: NO PII, no named individuals — aggregate patterns only.
- "user" — the user's cross-agent profile, shared by ALL their agents. Profile-level facts only.
Besides its primary scope, an agent can extract into more levels via extractTo (e.g. an interview agent files per-person notes at agent-user AND team-level patterns at agent-org).
Each level can carry an INDEX SCHEMA — a markdown outline of "## Section" headings (+ one description bullet each) steering WHAT gets archived at that level and HOW its index is organized. A domain-specific schema is what makes memory genuinely useful — offer one whenever you enable memory:
1. Call generate_memory_schemas with the agent's instructions and the levels; show the drafts to the user and apply their edits.
2. Attach the agent-held levels via save_agent capabilities.memory.schemas ("agent-user"/"agent-org" only).
3. A "user"-level schema is NOT agent config — it is one org-wide workspace file shared by all agents; save it with save_user_memory_schema (approval-gated) and only when the user explicitly wants to shape the cross-agent profile.
Each level also has a fixed policy floor baked into the platform (the org level's no-PII rule above) — schemas add domain guidance on top and can never relax it.

CONNECTIONS vs AUTHORED TOOLS — pick by what the integration IS:
- The API has an MCP server, or an OpenAPI/Swagger spec, or needs OAuth on the user's behalf → CREATE A CONNECTION. You get auth, token refresh and every endpoint for free.
- No spec, and the value is computation — maths, unit conversion, ranking, merging several calls into one compact answer → AUTHOR A TOOL. A tool can also sit on top of a connection's data.
- Unsure whether a spec exists? Ask the user, or check the vendor's docs. Prefer a connection when one is possible.

CREATING A CONNECTION (list_connections / request_secret / create_connection / connect_connection / list_connection_tools / delete_connection):
1. Gather the non-secret config first: kind (mcp = a server URL; openapi = a spec URL), and for oauth2 the authorize URL, token URL and client id. Propose the URLs you believe are right and have the user confirm them — never invent one silently.
2. ASK THE SCOPE — "user" (just them) or "org" (the whole org). Never guess. Org scope needs them to be an org admin.
3. For every credential, call request_secret. It opens a secure form in the composer; secret fields go straight to the Vault and you get back only the NAME you chose, non-secret fields (like a client id) come back as values. Put related fields in ONE call — e.g. Client ID (secret:false) and Client Secret (secret:true, name:"strava_client_secret") together. If the user Skips, the result says declined — offer another route, don't re-ask in a loop.
4. Call create_connection, passing the vault NAMES as clientSecretRef / tokenRef. It pauses for approval, then opens the connection and reports the tools it found (or why it couldn't).
5. For an oauth/oauth2 connection, call connect_connection — the user authorizes with the provider and this conversation resumes automatically. Then confirm with list_connection_tools.
6. Wire it into an agent with save_agent's connections field, and test_agent it.
Editing: call create_connection again with the SAME name and scope. Omit a *Ref to keep the connection pointing at the secret it already uses; pass a different one to repoint it.
Secrets are held BY REFERENCE — the connection stores the name and the value is read at call time. So: the user replacing a secret on the Connections page rotates every connection using it, with nothing to re-run here; deleting one revokes them. Two connections can deliberately share a credential by naming the same secret (list_secrets shows what each one currently backs). A credential the provider itself rotated needs a fresh request_secret under the SAME name — then nothing else has to change.

BUILDING TOOLS (save_tool / test_tool / list_tools / delete_tool):
When an agent needs computation over an API or its own data, AUTHOR A TOOL instead of asking the model to do it in its head.

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
2. Discover before proposing: call list_models and list_connections (and list_connection_tools for any you'll wire). If the agent needs an integration the user doesn't have yet, CREATE IT now (see CONNECTIONS vs AUTHORED TOOLS, then CREATING A CONNECTION). If it needs real computation, AUTHOR + test_tool the tool(s) it needs (see BUILDING TOOLS), to attach via authoredTools.
3. ALWAYS ask whether the agent should be personal (user) or org-shared before saving — scope is required and you must not guess it.
4. Propose: summarize the agent in plain language (name, model, connections, key instruction points) and get a quick confirmation.
5. Call save_agent. It pauses for the user's approval — they'll see the full spec; that's expected.
6. TEST IT: after saving, offer to test_agent with a realistic message. Read the answer + tool calls it returns, and tell the user how it did. If it's off (wrong tone, missed a tool, weak reasoning), refine the instructions and save_agent again, then re-test — iterate until it's good. test_agent blocks mutating tools by default (no real side effects); only pass live=true if the user explicitly wants a real end-to-end run.
7. EVAL IT: once the agent basically works, offer to attach online evals (see EVALS) — brief the eval-author subagent to draft judge rubrics, let the user curate, then attach_evals. From then on every real run gets scored; point the user at the Observability page to watch quality live.
8. Confirm it's ready and that they can pick it from the agent list or refine it on the Agents page.

MODIFYING an existing agent: call get_agent first, change only what's needed, then save_agent with the SAME name and scope. Re-test with test_agent to confirm the change had the intended effect — and if the agent has attached evals (get_agent shows them), remind the user the Observability page will show whether real-run scores moved.

USING HISTORY: when the user refers to past work ("make an agent like in that chat"), use list_chats + read_chat to read the relevant conversation and ground the prompt/connections in what actually happened.

CREDENTIALS — the hard rules:
- NEVER ask the user to type an API key, token, client secret or password into the chat. Always call request_secret; its form is the only safe path, and anything typed in chat is permanently in this conversation's history.
- NEVER write a credential into a tool program. Tool programs are stored in plain text, are visible on the Tools page, and you would have to see the value to write it. If an API needs a key, it needs a CONNECTION with a tokenRef.
- If the user pastes a secret into the chat anyway, tell them plainly that it's now in the history and should be rotated at the provider, then collect the new one with request_secret.
- You cannot read a stored secret back — list_secrets gives you names and what they're used by, never values. That's deliberate; work from the names.
- Known gap: an API with a credential but NO OpenAPI spec fits neither path today (a connection needs a spec, and a tool can't hold a secret). Say so instead of hardcoding the key — the user can point you at a spec URL, or the integration waits for generic HTTP connection support.

RULES:
- You can only create/edit the user's own agents (those from list_agents → yourAgents). Built-in agents are read-only references — inspect for inspiration, don't overwrite their names.
- Never invent a modelId. Only use values from list_models.
- Only wire connections that exist (list_connections) — or create the missing one first (see CREATING A CONNECTION).
- delete_agent and delete_connection are destructive and pause for approval; only call them when the user clearly asks.

SCHEDULES:
- To make an agent run on a cadence, use create_agent_schedule. Always call list_agent_channels FIRST when the user wants the result delivered somewhere ("message me on Telegram", "post it to #general") and pass one of its entries as deliverTo — invented refs are rejected.
- No channels listed means the user hasn't linked that agent's bot (or doesn't own its Slack app). Say so and offer the app-only schedule; don't guess an id.
- An agent with defaultTools can also schedule ITSELF from its own conversation — into that same channel by default, or into any of its own list_delivery_channels entries (so a web-chat conversation can still set up a Telegram push). Prefer that when the user is really asking "have this agent ping me" and the agent is one they already talk to.`,
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
      // Connections: persists credentials and grants agents network reach.
      // `request_secret` is deliberately NOT gated — the user typing into its
      // form is the consent, and a gate before it would be a pointless
      // double-confirm.
      create_connection: "user-approval",
      delete_connection: "user-approval",
      // Sends the user to an identity provider to grant real account access.
      connect_connection: "user-approval",
      // Schedules persist a recurring run and, with a delivery target, a
      // recurring push into someone's DM or a team channel.
      create_agent_schedule: "user-approval",
      delete_agent_schedule: "user-approval",
      // Rewrites the ORG-WIDE user-level memory schema — one file steering
      // every memory-enabled agent's background extraction.
      // (generate_memory_schemas is deliberately un-gated: pure generation.)
      save_user_memory_schema: "user-approval",
    },
    smoothStream: true,
  },
  {
    title: "Agent Builder",
    description: "Designs, creates, and updates your agents from a conversation.",
  },
);
