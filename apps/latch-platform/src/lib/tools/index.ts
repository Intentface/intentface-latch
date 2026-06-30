import { tool, jsonSchema } from "ai";
import { runTool } from "./runtime";
import type { ToolResult } from "./runtime";
import type { AuthoredTool, ToolStore } from "./store";

/**
 * The authored-tools layer: turns persisted {@link AuthoredTool} records into
 *  - executable AI-SDK tools (their `execute` runs the program in the sandbox), and
 *  - authoring meta-tools (`save_tool` / `test_tool` / `delete_tool` / `list_tools`)
 *    a builder agent uses to write, try, and manage tools in a conversation.
 *
 * Tools are scoped **personal** (per org+user) or **org** (shared org-wide),
 * exactly like agents/connections — the `ownerKey(principal, scope)` encodes it.
 * An ORG agent resolves only org tools (so every member gets them); a PERSONAL
 * agent resolves its owner's tools plus org tools (personal wins on a clash).
 */

export type ToolScope = "user" | "org";

/** Meta-tool names that an authored tool may not shadow. */
const RESERVED = new Set(["save_tool", "test_tool", "delete_tool", "list_tools"]);

const cleanName = (s: string): string => s.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48);

/** Normalize a host entry to a bare hostname (drop scheme/path). */
const cleanHost = (h: string): string =>
  String(h).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

export interface AuthoredToolsApi {
  /**
   * The caller's authored tools as executable AI-SDK tools, filtered to `names`.
   * `agentScope` "org" resolves only org tools; "user" merges org + personal
   * (personal wins). Default "user".
   */
  executableTools: (
    principal: unknown,
    names?: string[],
    agentScope?: ToolScope,
  ) => Promise<Record<string, unknown>>;
  /** Run a program once (Test panel / test_tool) without persisting it. */
  run: (args: { code: string; allowedHosts?: string[]; input?: unknown }) => Promise<ToolResult>;
  /** Authoring meta-tools for a builder agent. */
  authoringTools: (principal: unknown) => Record<string, unknown>;
  /** The caller's tools across scopes (each tagged), for the Tools page + picker. */
  listFor: (principal: unknown) => Promise<(AuthoredTool & { scope: ToolScope })[]>;
  getFor: (principal: unknown, scope: ToolScope, name: string) => Promise<AuthoredTool | null>;
  saveFor: (
    principal: unknown,
    scope: ToolScope,
    rec: Omit<AuthoredTool, "owner" | "createdAt" | "updatedAt">,
  ) => Promise<void>;
  deleteFor: (principal: unknown, scope: ToolScope, name: string) => Promise<void>;
  /** Normalize a name the same way save_tool does (letters/digits/underscore). */
  cleanName: (name: string) => string;
  /** Normalize a host entry to a bare hostname (drop scheme/path) — for save paths. */
  cleanHost: (host: string) => string;
  /** Whether a (cleaned) name collides with a reserved meta-tool. */
  isReserved: (name: string) => boolean;
  store: ToolStore;
}

export function createAuthoredTools(opts: {
  store: ToolStore;
  /** Owner key for a principal at a given scope (org → [org]; user → [org,user]). */
  ownerKey: (principal: unknown, scope: ToolScope) => string;
}): AuthoredToolsApi {
  const { store, ownerKey } = opts;

  const run: AuthoredToolsApi["run"] = ({ code, allowedHosts, input }) =>
    runTool(code, { input, allowedHosts: (allowedHosts ?? []).map(cleanHost).filter(Boolean) });

  /** Resolve the caller's tools by name into one map, honoring scope precedence. */
  const resolveTools = async (
    principal: unknown,
    agentScope: ToolScope,
  ): Promise<Map<string, AuthoredTool>> => {
    const byName = new Map<string, AuthoredTool>();
    for (const t of await store.list(ownerKey(principal, "org"))) byName.set(t.name, t); // org base
    if (agentScope === "user") {
      // Personal tools override org ones for a personal agent's owner.
      for (const t of await store.list(ownerKey(principal, "user"))) byName.set(t.name, t);
    }
    return byName;
  };

  const buildExecutable = (t: AuthoredTool): unknown =>
    tool({
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema as never),
      execute: async (input: unknown) => {
        const r = await runTool(t.code, { input, allowedHosts: t.allowedHosts });
        return r.status === "completed" ? r.result : { error: r.error };
      },
    });

  return {
    store,
    run,
    cleanName,
    cleanHost,
    isReserved: (name) => RESERVED.has(name),

    async listFor(principal) {
      const [org, user] = await Promise.all([
        store.list(ownerKey(principal, "org")),
        store.list(ownerKey(principal, "user")),
      ]);
      return [
        ...org.map((t) => ({ ...t, scope: "org" as const })),
        ...user.map((t) => ({ ...t, scope: "user" as const })),
      ];
    },
    getFor: (principal, scope, name) => store.get(ownerKey(principal, scope), name),
    saveFor: (principal, scope, rec) => store.save({ ...rec, owner: ownerKey(principal, scope) }),
    deleteFor: (principal, scope, name) => store.delete(ownerKey(principal, scope), name),

    async executableTools(principal, names, agentScope = "user") {
      const byName = await resolveTools(principal, agentScope);
      const allow = names ? new Set(names) : null;
      const out: Record<string, unknown> = {};
      for (const t of byName.values()) {
        if (allow && !allow.has(t.name)) continue;
        // Isolate per tool: a single malformed schema must not throw and take
        // down the whole turn — skip it and keep the rest.
        try {
          out[t.name] = buildExecutable(t);
        } catch (e) {
          console.warn(`Authored tool "${t.name}" skipped (invalid):`, e instanceof Error ? e.message : e);
        }
      }
      return out;
    },

    authoringTools(principal) {
      const orgOwner = ownerKey(principal, "org");
      return {
        list_tools: tool({
          description: "List your authored tools (name, description, allowed hosts, scope).",
          inputSchema: jsonSchema<Record<string, never>>({
            type: "object",
            properties: {},
            additionalProperties: false,
          }),
          execute: async () => {
            const [org, user] = await Promise.all([
              store.list(orgOwner),
              store.list(ownerKey(principal, "user")),
            ]);
            return [
              ...org.map((t) => ({ name: t.name, description: t.description, allowedHosts: t.allowedHosts, scope: "org" as const })),
              ...user.map((t) => ({ name: t.name, description: t.description, allowedHosts: t.allowedHosts, scope: "user" as const })),
            ];
          },
        }),

        test_tool: tool({
          description:
            "Run a tool program once with test input and get its result — WITHOUT saving. Use this to verify a program works (and that its fetches resolve) before save_tool. Mutating side effects are real, so test read-only programs freely.",
          inputSchema: jsonSchema<{ code: string; input?: unknown; allowedHosts?: string[] }>({
            type: "object",
            properties: {
              code: { type: "string", description: "Program body. Uses `input` + `fetch`, ends with `return`." },
              input: { type: "object", description: "Test arguments exposed as `input`." },
              allowedHosts: {
                type: "array",
                items: { type: "string" },
                description: 'Hostnames the program may fetch (e.g. ["api.open-meteo.com"]).',
              },
            },
            required: ["code"],
            additionalProperties: false,
          }),
          execute: async ({ code, input, allowedHosts }) => {
            const r = await run({ code, allowedHosts, input });
            return r.status === "completed" ? { ok: true, result: r.result } : { ok: false, error: r.error };
          },
        }),

        save_tool: tool({
          description:
            "Save a reusable authored tool (a JS program over `input` + `fetch`). On use, the program runs with `input` = the call args. Declare allowedHosts for any external API it fetches. `scope`: 'org' shares it org-wide (REQUIRED if you'll attach it to an org-scoped agent), 'user' keeps it personal (default).",
          inputSchema: jsonSchema<{
            name: string;
            description: string;
            inputSchema?: unknown;
            code: string;
            allowedHosts?: string[];
            scope?: ToolScope;
          }>({
            type: "object",
            properties: {
              name: { type: "string", description: "Tool name (letters/digits/underscore)." },
              description: { type: "string", description: "What it does + its inputs (the model reads this)." },
              inputSchema: { type: "object", description: "JSON Schema for the tool's input." },
              code: { type: "string", description: "Program body. Uses `input` + `fetch`, ends with `return <value>`." },
              allowedHosts: {
                type: "array",
                items: { type: "string" },
                description: "Hostnames the program's fetch may reach. Empty = no network.",
              },
              scope: { type: "string", enum: ["user", "org"], description: "'org' = shared org-wide; 'user' = personal (default)." },
            },
            required: ["name", "description", "code"],
            additionalProperties: false,
          }),
          execute: async ({ name, description, inputSchema, code, allowedHosts, scope }) => {
            const clean = cleanName(name);
            if (!clean) return { error: "invalid name" };
            if (RESERVED.has(clean)) return { error: `"${clean}" is reserved` };
            if (!String(code).trim()) return { error: "code is empty" };
            const toolScope: ToolScope = scope === "org" ? "org" : "user";
            await store.save({
              owner: ownerKey(principal, toolScope),
              name: clean,
              description: String(description),
              inputSchema: inputSchema ?? { type: "object" },
              code: String(code),
              allowedHosts: (allowedHosts ?? []).map(cleanHost).filter(Boolean),
            });
            return { saved: true, name: clean, scope: toolScope, note: "Attach it to an agent to make it usable." };
          },
        }),

        delete_tool: tool({
          description: "Delete one of your authored tools by name (defaults to personal scope; pass scope:'org' for a shared one).",
          inputSchema: jsonSchema<{ name: string; scope?: ToolScope }>({
            type: "object",
            properties: {
              name: { type: "string" },
              scope: { type: "string", enum: ["user", "org"] },
            },
            required: ["name"],
            additionalProperties: false,
          }),
          execute: async ({ name, scope }) => {
            const clean = cleanName(name);
            await store.delete(ownerKey(principal, scope === "org" ? "org" : "user"), clean);
            return { deleted: clean, scope: scope === "org" ? "org" : "user" };
          },
        }),
      };
    },
  };
}
