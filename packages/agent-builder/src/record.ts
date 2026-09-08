import { z } from "zod";
import type { MemoryConfig } from "@intentface/latch-core";

/**
 * THE agent record — one zod schema that every writer and reader derives from:
 * the persisted shape (`AgentRecord`), the builder's `save_agent` input, a
 * host's server-side validator, and a schema-driven editor form. Declared once
 * so a field can't exist in one home and not another.
 *
 * Zod-only on purpose (no `ai`, no runtime imports) — safe to ship to a
 * browser bundle via the `./record` subpath.
 *
 * Two kinds of rule live here:
 *  - shape + cross-field invariants that are TRUE FOR EVERY HOST (memory
 *    connection must be wired, org-shared memory needs an org agent, index
 *    schemas are outlines, …) → `AgentRecordSchema`.
 *  - canonicalization every writer must apply → `normalizeAgentRecord`.
 * Host policy (reserved names, who may attach org tools, which capabilities
 * exist) stays with the host / the builder's `CapabilitySupport`.
 */

/** Where a record lives: the caller's personal scope or the shared org scope. */
export const AgentScopeSchema = z.enum(["user", "org"]);
export type AgentScope = z.infer<typeof AgentScopeSchema>;

export const MemoryScopeSchema = z.enum(["agent-user", "agent-org", "user"]);

const MEMORY_LEVEL_DESCRIPTION =
  "'agent-user' = this agent's memory of each user (default choice); 'agent-org' = one shared memory for the whole org (requires the agent itself to have scope 'org'); 'user' = shared across all the user's agents.";

/**
 * Markdown index-schema outline: at least one real level-2 heading (`## ` +
 * text, CommonMark requires the space), or blank (dropped on normalize).
 */
const isOutline = (s: string) => !s.trim() || /^[ \t]*##(?!#)[ \t]+\S/m.test(s);

const MemorySchemaText = z
  .string()
  .max(4000, "Memory schema is too long (max 4000 chars).")
  .refine(isOutline, 'Memory schema needs at least one "## Section" heading — it is the index outline.');

export const MemoryConfigSchema = z.object({
  scope: MemoryScopeSchema.describe(MEMORY_LEVEL_DESCRIPTION),
  connection: z
    .string()
    .min(1)
    .describe(
      "Which of the agent's connections holds the memory files (must be in `connections`; typically 'loredex').",
    ),
  extractTo: z
    .array(MemoryScopeSchema)
    .optional()
    .describe(
      "EXTRA memory levels the background archivist also files facts into from the same conversations (the primary scope is always included). 'agent-org' here also requires the agent to have scope 'org'. Same connection for all levels.",
    ),
  schemas: z
    .strictObject({
      "agent-user": MemorySchemaText.optional(),
      "agent-org": MemorySchemaText.optional(),
    })
    .optional()
    .describe(
      "Markdown index-schema outlines per agent-held level ('## Section' headings + description bullets): what that level collects and how its MEMORY.md is organized. The shared 'user' level's schema is a workspace file, not agent config.",
    ),
  extraction: z.object({ idleMinutes: z.number().int().positive().optional() }).optional(),
  consolidation: z.object({ cooldownHours: z.number().positive().optional() }).optional(),
});

// Compile-time guarantee: what this schema produces IS a core `MemoryConfig`,
// so a parsed record's `exec.memory` can be handed to the runtime unchanged.
type _MemoryConfigMatchesCore = z.infer<typeof MemoryConfigSchema> extends MemoryConfig ? true : never;
const _memoryConfigMatchesCore: _MemoryConfigMatchesCore = true;
void _memoryConfigMatchesCore;

/**
 * One judge rubric attached to an agent. `trigger` is a host-defined predicate
 * tree (see the host's eval feature) — opaque here; the host narrows it.
 */
export const AttachedEvalSchema = z.object({
  name: z.string().min(1).describe("Kebab-case id — becomes the score name."),
  prompt: z.string().max(1000).describe("The judging instructions: one observable quality of a good response."),
  judgeModelId: z.string().optional().describe("Judge model override (default: the host judge model)."),
  scale: z.enum(["binary", "score"]).default("binary").describe("binary → pass/fail; score → graded 0–1."),
  enabled: z.boolean().default(true),
  trigger: z.unknown().optional().describe("When the judge runs — host-defined predicate; absent → every completed turn."),
  context: z.enum(["turn", "chat", "loop"]).optional().describe("What the judge sees: turn (default), chat, or loop."),
});
export type AttachedEval = z.infer<typeof AttachedEvalSchema>;

/**
 * Names the chat channels claim for their own `/` commands (`/new`, `/compact`,
 * …). A slash extension may not shadow them — the kernel parses those first,
 * so such an extension would be unreachable from Telegram/WhatsApp/Slack.
 * Mirrors core's `RESERVED_SLASH_NAMES` (this module stays zod-only).
 */
const RESERVED_SLASH_NAMES = new Set([
  "new",
  "reset",
  "compact",
  "cancel",
  "skip",
  "status",
  "help",
  "commands",
  "start",
]);

export const ExtensionTriggerSchema = z.enum(["slash", "chat-start", "every-turn"]);

/**
 * One agent extension: a script over the agent's tools plus a template, run
 * BEFORE the model. Shape mirrors core's `AgentExtension` (the record stores
 * `script` as text: JS subset or a JSON plan).
 */
export const AgentExtensionSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,31}$/)
      .describe("Identifier: lowercase letter first, then letters/digits/underscore. A slash extension is typed as /<name>."),
    description: z.string().max(200).optional().describe("One line — shown in the / menu and to authors."),
    on: ExtensionTriggerSchema.describe(
      "slash: runs when the user types /<name> args · chat-start: once per conversation (refreshable) · every-turn: before every message.",
    ),
    input: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("JSON Schema documenting the input. A typed slash invocation yields { args, argv }; a structured one is passed through."),
    script: z
      .string()
      .optional()
      .describe(
        "JavaScript subset over the agent's tools, e.g. `const h = await clockify_hours({ period: input.args }); return { h };`. Bare tool names, const only, no loops/new/globals — validated before it runs. Read-only unless allowMutations.",
      ),
    template: z
      .string()
      .optional()
      .describe("Liquid template over { input, output, steps, error } rendered into the prompt. Absent → the script output as a JSON block."),
    target: z
      .enum(["message", "instructions"])
      .optional()
      .describe("Where the rendered text lands: the user turn (default) or the system prompt."),
    placement: z
      .enum(["before", "after"])
      .optional()
      .describe("Message target: the rendered block goes before or after the user's own text (default after)."),
    scope: z
      .enum(["turn", "chat"])
      .optional()
      .describe("Instructions target: this turn only (default) or every later turn of the chat."),
    refresh: z
      .object({ afterMs: z.number().int().positive().optional() })
      .optional()
      .describe("chat-start only: run again when the last result is older than this many ms."),
    reveal: z
      .enum(["command", "prompt", "both"])
      .optional()
      .describe("What the user sees on their message: only what they typed (default), the rendered prompt in its place, or both."),
    allowMutations: z
      .boolean()
      .optional()
      .describe("Let the script call approval-gated (mutating) tools. Default false: such a call is refused before anything runs."),
    onError: z
      .enum(["proceed", "fail"])
      .optional()
      .describe("A failed script: proceed with the failure visible to the model (default), or fail the turn."),
    limits: z
      .object({
        timeoutMs: z.number().int().positive().optional(),
        maxRenderedChars: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .superRefine((ext, ctx) => {
    if (ext.script === undefined && ext.template === undefined) {
      ctx.addIssue({ code: "custom", path: ["script"], message: "An extension needs a script, a template, or both." });
    }
    if (ext.on === "slash" && RESERVED_SLASH_NAMES.has(ext.name)) {
      ctx.addIssue({
        code: "custom",
        path: ["name"],
        message: `"/${ext.name}" is reserved for chat commands (${[...RESERVED_SLASH_NAMES].join(", ")}).`,
      });
    }
    if (ext.refresh && ext.on !== "chat-start") {
      ctx.addIssue({ code: "custom", path: ["refresh"], message: "refresh only applies to chat-start extensions." });
    }
  });
export type AgentExtensionRecord = z.infer<typeof AgentExtensionSchema>;

/** Per-tool selection over the connections' tools. */
export const AgentToolsSchema = z.object({
  /** Namespaced tool names the model may call (empty → all). */
  enabled: z.array(z.string()),
  /** Per-tool override: true → require approval, false → waive it (overrides the connection default). */
  approval: z.record(z.string(), z.boolean()),
  /** Per-tool description overrides (by namespaced tool name). */
  descriptions: z.record(z.string(), z.string()).optional(),
});

export const EffortSchema = z.enum(["minimal", "low", "medium", "high"]);

/** Code-execution + harness capabilities. Every flag is optional; absent = off. */
export const AgentExecSchema = z.object({
  sandbox: z.boolean().optional().describe("Per-session workspace + file/shell tools (bash, read_file, …)."),
  provider: z.string().optional().describe("Sandbox backend id (host-specific). Omit for the host default."),
  defaultTools: z
    .union([z.boolean(), z.array(z.string())])
    .optional()
    .describe("App harness tools (host-defined: e.g. web_fetch, askUser, scheduling). true = all of them, or a list of tool names."),
  disableTools: z.array(z.string()).optional().describe("Harness tool names to opt out of."),
  providerWebTools: z.boolean().optional().describe("Native provider web search/fetch (Anthropic/OpenAI/Google)."),
  renderTools: z.boolean().optional().describe("Headless-browser fetch/render tool(s)."),
  authoredTools: z
    .array(z.string())
    .optional()
    .describe("Names of host-authored tools attached to this agent — only where the host offers tool authoring."),
  preApprovedWrites: z
    .boolean()
    .optional()
    .describe(
      "Waive the per-call approval pause on this agent's WRITE tools — the save approval is the consent. ONLY for agents that must run unattended (schedules); requires defaultTools.",
    ),
  effort: EffortSchema.optional().describe(
    "Reasoning/thinking effort. Only set for a model where list_models shows reasoning=true.",
  ),
  memory: MemoryConfigSchema.optional().describe(
    "Persistent cross-session memory: the host archives durable facts from idle chats into the connection's workspace, injects a compiled index each turn, and adds memory_search/memory_save tools.",
  ),
});

// `strictObject`, not `object`: the pre-schema builder took `effort` and
// `authoredTools` at the TOP level. Zod strips unknown keys by default, so a
// writer still emitting that shape would save an agent silently missing its
// configuration. Rejecting is the honest outcome. (`exec` itself stays
// non-strict: a stored row carrying a retired flag such as `codeMode` is NOT
// rejected — the unknown key is stripped on parse and simply not written back.
// Nothing reads it anymore, so dropping it is the whole migration.)
export const AgentRecordSchema = z
  .strictObject({
    name: z.string().min(1).describe("Unique kebab-case id. Reusing an existing name UPDATES that agent."),
    title: z.string().optional().describe("Short human label for the picker."),
    description: z.string().optional().describe("One line on what the agent does."),
    modelId: z.string().min(1).describe("Must be an id returned by list_models."),
    instructions: z.string().min(1).describe("The system prompt — the heart of the agent. Be specific."),
    connections: z.array(z.string()).default([]).describe("Connection names from list_connections."),
    maxSteps: z
      .union([z.number().int().min(1), z.literal("unlimited")])
      .optional()
      .describe("Tool-loop ceiling: a number caps steps; \"unlimited\" runs until done; omit for the default."),
    tools: AgentToolsSchema.optional(),
    exec: AgentExecSchema.optional(),
    subagents: z.array(z.string()).optional().describe("Names of agents this one may delegate to."),
    attachedEvals: z.array(AttachedEvalSchema).optional(),
    extensions: z
      .array(AgentExtensionSchema)
      .optional()
      .describe(
        "Pre-turn scripts + templates (slash commands, chat-start data loaders, every-turn context). Only where the host runs a script engine.",
      ),
    scope: AgentScopeSchema.describe("'user' (personal) or 'org' (shared). Ask the user — never guess."),
  })
  .superRefine((rec, ctx) => {
    if (!normalizeAgentName(rec.name)) {
      ctx.addIssue({ code: "custom", path: ["name"], message: "invalid name" });
    }
    if (rec.extensions) {
      const seen = new Set<string>();
      rec.extensions.forEach((e, i) => {
        if (seen.has(e.name)) {
          ctx.addIssue({ code: "custom", path: ["extensions", i, "name"], message: `Duplicate extension name "${e.name}".` });
        }
        seen.add(e.name);
      });
    }
    const mem = rec.exec?.memory;
    if (!mem) return;
    // Memory files live in one of the agent's OWN connections. A dangling name
    // would silently disable recall while looking configured.
    if (!rec.connections.includes(mem.connection)) {
      ctx.addIssue({
        code: "custom",
        path: ["exec", "memory", "connection"],
        message: `Memory connection "${mem.connection}" must also be listed in the agent's connections.`,
      });
    }
    // agent-org memory is keyed by agent name alone — restrict it to
    // org-visible agents so same-named personal agents can't share a store.
    // Applies to the primary scope AND every extraction level.
    const levels = [mem.scope, ...(mem.extractTo ?? [])];
    if (levels.includes("agent-org") && rec.scope !== "org") {
      ctx.addIssue({
        code: "custom",
        path: ["exec", "memory", "scope"],
        message: `Org-shared memory ('agent-org') requires scope: "org" on the agent itself.`,
      });
    }
  });

/** The persisted record — the schema's output type. */
export type AgentRecord = z.infer<typeof AgentRecordSchema>;
/** What a writer may pass in (defaults not yet applied). */
export type AgentRecordInput = z.input<typeof AgentRecordSchema>;

/**
 * Canonical agent-name normalization — used by EVERY writer (host editors and
 * the builder's save_agent) so the same intended name always maps to one
 * record. Lowercased kebab, underscores allowed.
 */
export const normalizeAgentName = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "");

/**
 * Channel bindings and run records pin an agent to one scope with an
 * `org:`/`user:` prefix (stored names never contain `:` — normalizeAgentName
 * strips it). Split a possibly-pinned reference.
 */
export function parseAgentRef(ref: string): { name: string; scope?: AgentScope } {
  const m = /^(org|user):(.+)$/.exec(ref);
  return m ? { name: m[2]!, scope: m[1] as AgentScope } : { name: ref };
}

const blankToUndefined = (s: string | undefined): string | undefined => {
  const t = s?.trim();
  return t ? t : undefined;
};

/** Drop `undefined` values; return undefined when nothing is left. */
function compact<T extends object>(obj: T): T | undefined {
  const out = Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Canonicalize a validated record before persisting. Idempotent. Every writer
 * runs this so the stored form is the same regardless of who wrote it:
 *  - name normalized; title/description trimmed (blank → absent)
 *  - `exec.memory.extractTo` = unique levels, primary first (absent when it
 *    would only repeat the primary); blank index schemas dropped
 *  - empty `exec` / `subagents` / `schemas` / `extensions` → absent, not `{}` / `[]`
 */
export function normalizeAgentRecord(rec: AgentRecord): AgentRecord {
  let exec = rec.exec ? { ...rec.exec } : undefined;
  if (exec?.memory) {
    const mem = { ...exec.memory };
    const levels = [...new Set([mem.scope, ...(mem.extractTo ?? [])])];
    mem.extractTo = levels.length > 1 ? levels : undefined;
    if (mem.schemas) {
      const kept = Object.fromEntries(
        Object.entries(mem.schemas).filter(([, s]) => s != null && s.trim()),
      ) as NonNullable<MemoryConfig["schemas"]>;
      mem.schemas = Object.keys(kept).length ? kept : undefined;
    }
    exec.memory = compact(mem) as typeof mem;
  }
  if (exec) {
    if (exec.authoredTools && exec.authoredTools.length === 0) exec.authoredTools = undefined;
    if (exec.disableTools && exec.disableTools.length === 0) exec.disableTools = undefined;
    exec = compact(exec);
  }
  return {
    ...rec,
    name: normalizeAgentName(rec.name),
    title: blankToUndefined(rec.title),
    description: blankToUndefined(rec.description),
    exec,
    subagents: rec.subagents?.length ? rec.subagents : undefined,
    attachedEvals: rec.attachedEvals?.length ? rec.attachedEvals : undefined,
    extensions: rec.extensions?.length ? rec.extensions : undefined,
  };
}

/** Parse + normalize in one step — what a server-side writer wants. Throws `ZodError` on invalid input. */
export function parseAgentRecord(input: unknown): AgentRecord {
  return normalizeAgentRecord(AgentRecordSchema.parse(input));
}
