/**
 * Edge Eval v0 — read reference material LIVE through the eval principal's connections.
 * Used by the judge (reference block) and the report (background section). Nothing is
 * written anywhere by these helpers, and nothing read here is persisted to the repo.
 */
import type { Principal } from "../../../lib/session";
import { CONNECTIONS } from "../variants";
import { PILLAR_FOR, type Category } from "./rubric";

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

/**
 * The body of a markdown doc's `## <heading>` section, up to the next heading of the same
 * or higher level. Shared by the report's background, the A′ client card and the judge.
 */
export function section(md: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$([\\s\\S]*?)(?=^#{1,2}\\s|(?![\\s\\S]))`, "m");
  const m = re.exec(md);
  return m ? m[1]!.trim() : "";
}

/** The client's memory files, discovered live (orient lists edge/memory/*). */
export async function listMemoryFiles(client: Opened): Promise<string[]> {
  const manifest = await callTool(client, `${CONNECTIONS.client}_orient`, {});
  const listing = manifest.split(/^\s*memory\/ \(\d+ files\)/m)[1]?.split(/^\s*\S+\/ \(\d+ files\)/m)[0] ?? "";
  return [...listing.matchAll(/^\s*- (\S+\.md) \[/gm)].map((m) => `edge/memory/${m[1]}`).filter((f) => !f.endsWith("/index.md"));
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

/**
 * The judge's reference material, fetched live once per run: the whole client plane
 * (Tier 2 ctx + Tier 3 memory) and, per category, that pillar's playbook plus the peer
 * catalog. Shared by the per-dimension cell judge and the pairwise pair judge so both
 * ground on exactly the same material.
 */
export async function loadJudgeReference(principal: Principal, dynamic: Dynamic) {
  return withPlanes(dynamic, principal, async (client, kn) => {
    // Tier 2 (ctx) AND Tier 3 (memory): the agent legitimately grounds in prior engagement
    // notes, so the judge must see them too — otherwise every fact drawn from memory reads
    // as "invented" (pilot-luna, first judge pass: 15 false invented_client_fact verdicts).
    const parts: string[] = [];
    for (const f of CTX_FILES) parts.push(`--- ${f} (Tier 2, client context) ---\n${await readViaConnection(client, `${CONNECTIONS.client}_read_file`, f)}`);
    for (const f of await listMemoryFiles(client)) parts.push(`--- ${f} (Tier 3, engagement memory — prior exchanges with this client) ---\n${await readViaConnection(client, `${CONNECTIONS.client}_read_file`, f)}`);
    const clientContext = parts.join("\n\n");
    // Expert stance = the category's pillar + the peer-examples catalog (IF's own case
    // studies — a cited peer is house material, not an invented company).
    const catalog = await readViaConnection(kn, `${CONNECTIONS.kn}_read_file`, "edge-kn/examples/catalog.md");
    const stances: Partial<Record<Category, string>> = {};
    for (const [cat, pillar] of Object.entries(PILLAR_FOR) as Array<[Category, string]>) {
      const playbook = await readViaConnection(kn, `${CONNECTIONS.kn}_read_file`, `edge-kn/kn/${pillar}/playbook.md`);
      stances[cat] = `--- edge-kn/kn/${pillar}/playbook.md (the pillar) ---\n${playbook}\n\n--- edge-kn/examples/catalog.md (approved peer examples the advisor may cite) ---\n${catalog}`;
    }
    return { clientContext, stances: stances as Record<Category, string> };
  });
}
