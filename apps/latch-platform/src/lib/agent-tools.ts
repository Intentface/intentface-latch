/**
 * The tools an agent has beyond its connections: what its settings switch on
 * — a sandbox, the default app tools, render, provider web search, memory,
 * authored tools, subagents. Read from the same sets the runtime grants, so
 * what the evals agent writes questions about, and what "calls a tool" can
 * pick, is what the agent really has. Server-only.
 */
import type { AgentRecord } from "./agent-store";
import { appTools, renderTools, sandboxTools } from "./sandbox/tools";

export type BuiltInTool = { name: string; from: string; description: string };

const describe = (t: unknown) => {
  const d = (t as { description?: unknown } | null)?.description;
  return typeof d === "string" ? d.split("\n")[0].slice(0, 200) : "";
};

export function builtInToolsOf(rec: Pick<AgentRecord, "exec" | "subagents">): BuiltInTool[] {
  const exec = rec.exec ?? {};
  const off = new Set(exec.disableTools ?? []);
  const out: BuiltInTool[] = [];
  const add = (set: Record<string, unknown>, from: string, only?: Set<string> | null) => {
    for (const [name, t] of Object.entries(set)) if ((!only || only.has(name)) && !off.has(name)) out.push({ name, from, description: describe(t) });
  };
  if (exec.sandbox) add(sandboxTools, `sandbox (${exec.provider ?? "just-bash"})`);
  if (exec.defaultTools) add(appTools, "default tools", Array.isArray(exec.defaultTools) ? new Set(exec.defaultTools) : null);
  if (exec.renderTools) add(renderTools, "render");
  if (exec.providerWebTools) {
    out.push({ name: "web_search", from: "the model provider", description: "Search the web" });
    out.push({ name: "web_fetch", from: "the model provider", description: "Fetch a web page" });
  }
  if (exec.memory) {
    out.push({ name: "memory_search", from: "memory", description: "Search what it remembers about this user" });
    out.push({ name: "memory_save", from: "memory", description: "Save a durable fact to remember" });
  }
  for (const name of exec.authoredTools ?? []) out.push({ name, from: "authored tool", description: "" });
  if (rec.subagents?.length) out.push({ name: "spawn_agent", from: "subagents", description: `Delegate to: ${rec.subagents.join(", ")}` });
  return out;
}
