import type { ReactNode } from "react";
import type { Item, Node, Root } from "fumadocs-core/page-tree";
import { DOCS_BASE_URL, source } from "@/lib/source";

/**
 * The agent entry point: one page listing every doc with its description and a
 * markdown URL. The intro carries the operating instructions that save a round
 * trip — how to fetch a page as markdown, and what the package actually is.
 */
const SUMMARY = [
  "This is the documentation for `@intentface/latch-*` — Latch, a reusable backend for building, persisting and operating AI agents on the Vercel AI SDK.",
  "It embeds into an existing backend (or runs standalone): the agent loop, an append-only run log, message projections, human-in-the-loop approvals, durability, schedules, memory, MCP/OpenAPI tools, and per-run cost accounting — all behind swappable seams.",
  "Every page below is markdown: append `.md` to any docs URL to fetch the same content as plain text. `/llms-full.txt` is every page concatenated.",
].join("\n");

// Page-tree names are ReactNode; ours come from frontmatter, so they're strings.
const asText = (value: ReactNode): string => (typeof value === "string" ? value : "");

const isExternal = (page: Item): boolean =>
  page.external ?? /^[a-z][a-z0-9+.-]*:\/\//i.test(page.url);

/**
 * One list entry per page. Absolute URLs are emitted verbatim — prefixing the
 * site origin onto `https://…` would produce a broken link, and an external page
 * has no `.md` twin to fetch.
 */
function lineFor(page: Item, site: string): string {
  // Derive the slug from the configured base URL, not a hardcoded "/docs" — if
  // the two drift, getPage returns undefined for every node and each entry
  // silently loses its title and description with no error.
  const slug = page.url
    .slice(page.url.startsWith(DOCS_BASE_URL) ? DOCS_BASE_URL.length : 0)
    .split("/")
    .filter(Boolean);
  const doc = source.getPage(slug);
  const title = asText(page.name) || doc?.data.title || page.url;
  const described = doc?.data.description ? `: ${doc.data.description}` : "";
  const href = isExternal(page) ? page.url : `${site}${page.url}.md`;
  return `- [${title}](${href})${described}`;
}

function walk(nodes: Node[], site: string, depth = 0): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "page":
        lines.push(lineFor(node, site));
        break;
      case "folder": {
        const name = asText(node.name);
        if (name) lines.push(`${"#".repeat(Math.min(depth + 2, 6))} ${name}`, "");
        // A folder's own index page is a real page — listing only `children`
        // silently drops it (and it is usually the section's overview).
        if (node.index) lines.push(lineFor(node.index, site));
        lines.push(...walk(node.children, site, depth + 1));
        break;
      }
      case "separator": {
        const name = asText(node.name);
        if (name) lines.push("", `${"#".repeat(Math.min(depth + 2, 6))} ${name}`, "");
        break;
      }
    }
  }
  return lines;
}

export function GET(request: Request): Response {
  // Derive the origin from the request so a deployed response never emits
  // localhost links. NEXT_PUBLIC_DOCS_URL overrides it for the case where the
  // public origin differs from what the app sees (a proxy or rewrite).
  const configured = process.env.NEXT_PUBLIC_DOCS_URL?.trim();
  const site = (configured || new URL(request.url).origin).replace(/\/+$/, "");

  const tree = source.getPageTree() as Root;
  const body = [
    "# Latch documentation",
    "",
    SUMMARY,
    "",

    ...walk(tree.children, site),
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
}
