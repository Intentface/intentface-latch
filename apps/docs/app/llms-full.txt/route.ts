import { readFile } from "node:fs/promises";
import path from "node:path";
import { source } from "@/lib/source";

/**
 * The whole documentation as one markdown file — for a model with a large
 * context window that wants everything at once (the AI SDK's `llms.txt`
 * convention). `/llms.txt` stays the index for hop-to-the-page use. Pages are
 * emitted in sidebar order, each with its URL so a quote can be attributed.
 */
export async function GET(request: Request): Promise<Response> {
  const configured = process.env.NEXT_PUBLIC_DOCS_URL?.trim();
  const site = (configured || new URL(request.url).origin).replace(/\/+$/, "");
  const base = path.join(process.cwd(), "content", "docs");

  const parts: string[] = [
    "# Latch documentation (full)",
    "",
    "Every page of https://…/docs concatenated in sidebar order. For an index with one line per page, fetch /llms.txt instead.",
    "",
  ];
  for (const page of source.getPages()) {
    const slug = page.slugs;
    const candidates = [
      path.join(base, `${slug.join("/")}.mdx`),
      path.join(base, ...slug, "index.mdx"),
    ];
    let text: string | undefined;
    for (const file of candidates) {
      if (!path.resolve(file).startsWith(path.resolve(base))) continue;
      try {
        text = await readFile(file, "utf8");
        break;
      } catch {
        /* next candidate */
      }
    }
    if (text === undefined) continue;
    // Drop the frontmatter block; the title is repeated as a heading with the URL.
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
    parts.push("", "---", "", `# ${page.data.title}`, "", `Source: ${site}${page.url}`, "", body.trim(), "");
  }
  return new Response(parts.join("\n"), {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" },
  });
}
