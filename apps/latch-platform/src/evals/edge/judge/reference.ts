/**
 * Edge Eval v0 — read reference material LIVE through the eval principal's connections.
 * Used by the judge (reference block) and the report (background section). Nothing is
 * written anywhere by these helpers, and nothing read here is persisted to the repo.
 */
import type { Principal } from "../../../lib/session";
import { CONNECTIONS } from "../variants";

export type Opened = { tools: Record<string, unknown>; close: () => Promise<void> };
type Executable = { execute?: (input: unknown, opts: { toolCallId: string; messages: unknown[] }) => Promise<unknown> };
export type Dynamic = { hostFor: (names: string[]) => { open: (p: Principal) => Promise<Opened> } };

export function textOf(result: unknown): string {
  if (typeof result === "string") return result;
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  if (Array.isArray(r?.content)) return r.content.map((c) => c.text ?? "").join("\n");
  return JSON.stringify(result);
}

/** Strip the `N|` line-number prefixes Loredex read_file returns. */
export const stripLineNumbers = (s: string) => s.replace(/^\d+\|/gm, "");

export async function callTool(opened: Opened, tool: string, input: unknown): Promise<string> {
  const t = opened.tools[tool] as Executable | undefined;
  if (!t?.execute) throw new Error(`tool ${tool} not available on the opened connection`);
  return textOf(await t.execute(input, { toolCallId: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, messages: [] }));
}

export async function readViaConnection(opened: Opened, tool: string, fileId: string): Promise<string> {
  const raw = await callTool(opened, tool, { fileId });
  try {
    const parsed = JSON.parse(raw) as { content?: string; files?: Array<{ content?: string }> };
    const content = parsed.content ?? parsed.files?.map((f) => f.content ?? "").join("\n\n");
    if (content) return stripLineNumbers(content);
  } catch {
    /* not JSON — raw text */
  }
  return stripLineNumbers(raw);
}

/** The client's memory files, discovered live (orient lists edge/memory/*). */
export async function listMemoryFiles(client: Opened): Promise<string[]> {
  const manifest = await callTool(client, `${CONNECTIONS.client}_orient`, {});
  const section = manifest.split(/^\s*memory\/ \(\d+ files\)/m)[1]?.split(/^\s*\S+\/ \(\d+ files\)/m)[0] ?? "";
  return [...section.matchAll(/^\s*- (\S+\.md) \[/gm)].map((m) => `edge/memory/${m[1]}`).filter((f) => !f.endsWith("/index.md"));
}

export const CTX_FILES = ["edge/ctx/placement.md", "edge/ctx/strategy.md", "edge/ctx/product.md", "edge/ctx/roadmap.md", "edge/ctx/tech-stack.md"];

/** Open both planes, run `fn`, always close. */
export async function withPlanes<T>(dynamic: Dynamic, principal: Principal, fn: (client: Opened, kn: Opened) => Promise<T>): Promise<T> {
  const client = await dynamic.hostFor([CONNECTIONS.client]).open(principal);
  const kn = await dynamic.hostFor([CONNECTIONS.kn]).open(principal);
  try {
    return await fn(client, kn);
  } finally {
    await client.close();
    await kn.close();
  }
}
