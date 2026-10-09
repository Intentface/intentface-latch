import { readFile } from "node:fs/promises";
import path from "node:path";
import { expandTypeTables } from "@/lib/type-tables";

/**
 * Serves a doc page's raw `.mdx` as `text/plain`, so appending `.md` to any
 * docs URL returns the source: readable in-browser, pasteable into an LLM, and
 * fetchable by an agent that can't run the page. The slug maps directly onto
 * `content/docs`, mirroring the fumadocs route.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const { slug } = await params;

  // Reject anything that could escape content/docs — slugs are plain segments.
  if (!slug?.length || slug.some((s) => s.includes("..") || s.includes("/"))) {
    return new Response("Not found", { status: 404 });
  }

  const base = path.join(process.cwd(), "content", "docs");
  // `/docs/concepts/runtime.md` → concepts/runtime.mdx; `/docs.md` (the index) → index.mdx.
  const candidates = [
    path.join(base, `${slug.join("/")}.mdx`),
    path.join(base, ...slug, "index.mdx"),
  ];

  for (const file of candidates) {
    if (!path.resolve(file).startsWith(path.resolve(base))) continue;
    try {
      const text = expandTypeTables(await readFile(file, "utf8"));
      return new Response(text, {
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "cache-control": "public, max-age=0, must-revalidate",
        },
      });
    } catch {
      // try the next candidate
    }
  }
  return new Response("Not found", { status: 404 });
}
