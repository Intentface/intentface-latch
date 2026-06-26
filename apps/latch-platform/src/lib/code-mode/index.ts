import { tool, jsonSchema } from "ai";
import { runCode, type CodeBridge } from "./quickjs-runtime";

/**
 * `codeModeWrap` — the platform's implementation of `RuntimeConfig.codeModeWrap`.
 * Folds a set of (connection) tools into ONE `run_code` tool: the model writes a
 * JS program that calls them as functions inside a QuickJS sandbox, instead of
 * many tool-call round-trips. The host runs the real calls (creds stay host-side).
 *
 * Tool discovery is on-demand (`tools.search`/`tools.describe`) rather than
 * dumping every schema into the prompt — scales to agents with many connections.
 * See docs/CODE_MODE.md.
 */

/** Loose shape of an AI SDK tool — enough to describe + dispatch it. */
type AiTool = {
  description?: string;
  inputSchema?: unknown;
  execute?: (input: unknown, options: unknown) => Promise<unknown> | unknown;
};

const CAPS = { memBytes: 64 * 1024 * 1024, timeoutMs: 10_000, maxResultBytes: 32_000 };

/** Best-effort JSON Schema for a tool (jsonSchema() tools expose `.jsonSchema`). */
function jsonSchemaOf(t: AiTool): unknown {
  const s = t.inputSchema as { jsonSchema?: unknown } | undefined;
  return s?.jsonSchema ?? (s && typeof s === "object" ? s : undefined);
}

export function codeModeWrap(
  tools: Record<string, unknown>,
  _opts?: { agent: string },
): Record<string, unknown> {
  const entries = Object.entries(tools) as [string, AiTool][];
  const byName = new Map(entries);

  const bridge: CodeBridge = {
    search: (q) => {
      const query = q.toLowerCase();
      const hits = entries
        .filter(
          ([name, t]) =>
            !query ||
            name.toLowerCase().includes(query) ||
            (t.description ?? "").toLowerCase().includes(query),
        )
        .slice(0, 25)
        .map(([name, t]) => ({
          name,
          description: (t.description ?? "").split("\n")[0].slice(0, 200),
        }));
      return JSON.stringify(hits);
    },
    describe: (name) => {
      const t = byName.get(name);
      if (!t) return JSON.stringify({ error: `unknown tool: ${name}` });
      return JSON.stringify({ name, description: t.description ?? "", inputSchema: jsonSchemaOf(t) });
    },
    call: async (opJson) => {
      let op: { name: string; input: unknown };
      try {
        op = JSON.parse(opJson);
      } catch {
        return JSON.stringify({ error: "bad op json" });
      }
      const t = byName.get(op.name);
      if (!t?.execute) {
        return JSON.stringify({ error: `unknown or non-callable tool: ${op.name}` });
      }
      try {
        const value = await t.execute(op.input, { toolCallId: "code-mode", messages: [] });
        return JSON.stringify({ value });
      } catch (e) {
        return JSON.stringify({ error: (e as Error)?.message ?? String(e) });
      }
    },
  };

  const names = entries.map(([n]) => n).join(", ");
  const run_code = tool({
    description:
      "Run a JavaScript program that orchestrates your tools as functions — one " +
      "program instead of many tool-call round-trips. Inside the code you have a " +
      "global `tools`:\n" +
      "- `tools.search(query)` → [{ name, description }] matching tools\n" +
      "- `tools.describe(name)` → { name, description, inputSchema }\n" +
      "- `await tools.call(name, input)` → the tool's result (throws on tool error)\n" +
      "Write normal JS (filter/map/loops/dates/JSON). End with `return <value>` to " +
      "return a JSON-serializable result. There is NO network, filesystem, or import " +
      "— only `tools`. Call `tools.search(...)` first to find what's available.\n" +
      `Available tools: ${names}`,
    inputSchema: jsonSchema<{ code: string }>({
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript program body. Use `return` to produce the result.",
        },
      },
      required: ["code"],
      additionalProperties: false,
    }),
    execute: async ({ code }) => runCode(code, bridge, CAPS),
  });

  return { run_code };
}
