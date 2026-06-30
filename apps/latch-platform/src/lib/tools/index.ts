import { tool, jsonSchema } from "ai";
import { runTool, type ToolResult } from "./runtime";
import type { ToolStore } from "./store";

/**
 * The authored-tools layer: turns persisted {@link AuthoredTool} records into
 *  - executable AI-SDK tools (their `execute` runs the program in the sandbox), and
 *  - authoring meta-tools (`save_tool` / `test_tool` / `delete_tool` / `list_tools`)
 *    a builder agent uses to write, try, and manage tools in a conversation.
 *
 * Owner isolation flows from `ownerKey(principal)` — the same key the rest of the
 * platform's storage uses, so a tool an agent authors lands at the user's scope.
 */

/** Meta-tool names that an authored tool may not shadow. */
const RESERVED = new Set(["save_tool", "test_tool", "delete_tool", "list_tools"]);

const cleanName = (s: string): string => s.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48);

/** Normalize a host entry to a bare hostname (drop scheme/path). */
const cleanHost = (h: string): string =>
  String(h).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

export interface AuthoredToolsApi {
  /** The owner's authored tools as executable AI-SDK tools (filtered to `names` if given). */
  executableTools(principal: unknown, names?: string[]): Promise<Record<string, unknown>>;
  /** Run a program once (Test panel / test_tool) without persisting it. */
  run(args: { code: string; allowedHosts?: string[]; input?: unknown }): Promise<ToolResult>;
  /** Authoring meta-tools for a builder agent. */
  authoringTools(principal: unknown): Record<string, unknown>;
  /** The owner key for a principal — so callers (server fns) key the store identically. */
  ownerKey(principal: unknown): string;
  /** Normalize a name the same way save_tool does (letters/digits/underscore). */
  cleanName(name: string): string;
  store: ToolStore;
}

export function createAuthoredTools(opts: {
  store: ToolStore;
  ownerKey: (principal: unknown) => string;
}): AuthoredToolsApi {
  const { store, ownerKey } = opts;

  const run: AuthoredToolsApi["run"] = ({ code, allowedHosts, input }) =>
    runTool(code, { input, allowedHosts: (allowedHosts ?? []).map(cleanHost).filter(Boolean) });

  return {
    store,
    run,
    ownerKey,
    cleanName,

    async executableTools(principal, names) {
      const owner = ownerKey(principal);
      const saved = await store.list(owner);
      const allow = names ? new Set(names) : null;
      const out: Record<string, unknown> = {};
      for (const t of saved) {
        if (allow && !allow.has(t.name)) continue;
        // Isolate per tool: a single malformed schema must not throw and take
        // down the whole turn — skip it and keep the rest.
        try {
          out[t.name] = tool({
            description: t.description,
            inputSchema: jsonSchema(t.inputSchema as never),
            execute: async (input: unknown) => {
              const r = await runTool(t.code, { input, allowedHosts: t.allowedHosts });
              return r.status === "completed" ? r.result : { error: r.error };
            },
          });
        } catch (e) {
          console.warn(`Authored tool "${t.name}" skipped (invalid):`, e instanceof Error ? e.message : e);
        }
      }
      return out;
    },

    authoringTools(principal) {
      const owner = ownerKey(principal);
      return {
        list_tools: tool({
          description: "List your authored tools (name, description, allowed hosts).",
          inputSchema: jsonSchema<Record<string, never>>({
            type: "object",
            properties: {},
            additionalProperties: false,
          }),
          execute: async () => {
            const saved = await store.list(owner);
            return saved.map((t) => ({
              name: t.name,
              description: t.description,
              allowedHosts: t.allowedHosts,
            }));
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
                description: "Hostnames the program may fetch (e.g. [\"api.open-meteo.com\"]).",
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
            "Save a reusable authored tool (a JS program over `input` + `fetch`). On use, the program runs with `input` = the call args. Declare allowedHosts for any external API it fetches. Available to attach to your agents.",
          inputSchema: jsonSchema<{
            name: string;
            description: string;
            inputSchema?: unknown;
            code: string;
            allowedHosts?: string[];
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
            },
            required: ["name", "description", "code"],
            additionalProperties: false,
          }),
          execute: async ({ name, description, inputSchema, code, allowedHosts }) => {
            const clean = cleanName(name);
            if (!clean) return { error: "invalid name" };
            if (RESERVED.has(clean)) return { error: `"${clean}" is reserved` };
            await store.save({
              owner,
              name: clean,
              description: String(description),
              inputSchema: inputSchema ?? { type: "object" },
              code: String(code),
              allowedHosts: (allowedHosts ?? []).map(cleanHost).filter(Boolean),
            });
            return { saved: true, name: clean, note: "Attach it to an agent to make it usable." };
          },
        }),

        delete_tool: tool({
          description: "Delete one of your authored tools by name.",
          inputSchema: jsonSchema<{ name: string }>({
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: false,
          }),
          execute: async ({ name }) => {
            const clean = cleanName(name);
            await store.delete(owner, clean);
            return { deleted: clean };
          },
        }),
      };
    },
  };
}
