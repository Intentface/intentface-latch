import type { ReactNode } from "react";
import { source } from "@/lib/source";

const SITE = process.env.NEXT_PUBLIC_DOCS_URL ?? "http://localhost:3100";

/**
 * The agent entry point: one page listing every doc with its description and a
 * markdown URL. The intro carries the operating instructions that save a round
 * trip — how to fetch a page as markdown, and what the package actually is.
 */
const SUMMARY = [
  "This is the documentation for `@intentface/latch-*` — Latch, a reusable backend for building, persisting and operating AI agents on the Vercel AI SDK.",
  "It embeds into an existing backend (or runs standalone): the agent loop, an append-only run log, message projections, human-in-the-loop approvals, durability, schedules, memory, MCP/OpenAPI tools, and per-run cost accounting — all behind swappable seams.",
  "Every page below is markdown: append `.md` to any docs URL to fetch the same content as plain text.",
].join("\n");

type TreeNode = {
  type: string;
  name?: ReactNode;
  url?: string;
  children?: TreeNode[];
};

// Page-tree names are ReactNode; ours come from frontmatter, so they're strings.
const asText = (value: ReactNode): string => (typeof value === "string" ? value : "");

function walk(nodes: TreeNode[], depth = 0): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    if (node.type === "folder") {
      const name = asText(node.name);
      if (name) lines.push(`${"#".repeat(Math.min(depth + 2, 6))} ${name}`, "");
      lines.push(...walk(node.children ?? [], depth + 1));
      continue;
    }
    if (node.type !== "page" || !node.url) continue;
    const page = source.getPage(node.url.replace(/^\/docs\/?/, "").split("/").filter(Boolean));
    const title = asText(node.name) || page?.data.title || node.url;
    const description = page?.data.description ? `: ${page.data.description}` : "";
    lines.push(`- [${title}](${SITE}${node.url}.md)${description}`);
  }
  return lines;
}

export function GET() {
  const tree = source.getPageTree() as unknown as TreeNode;
  const body = [
    "# Latch documentation",
    "",
    SUMMARY,
    "",
    "## Pages",
    "",
    ...walk(tree.children ?? []),
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
}
