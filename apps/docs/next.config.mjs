import { createMDX } from "fumadocs-mdx/next";

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // The docs read source files (see app/docs-markdown) at request time.
  outputFileTracingIncludes: {
    "/docs-markdown/**": ["./content/docs/**/*"],
    "/llms-full.txt": ["./content/docs/**/*"],
  },
  // Pages that moved in the docs restructure. Old links, llms.txt copies and
  // search results keep working; `.md` copies follow the same moves.
  async redirects() {
    const moved = {
      "/docs/foundations": "/docs/concepts",
      "/docs/foundations/principals": "/docs/guides/ownership-patterns",
      "/docs/foundations/turns": "/docs/concepts/turns",
      "/docs/foundations/run-log": "/docs/concepts/run-log",
      "/docs/foundations/seams": "/docs/reference/seams",
      "/docs/runtime": "/docs/concepts/runtime",
      "/docs/agents": "/docs/concepts/agents",
      "/docs/operations": "/docs/guides/crash-recovery",
      "/docs/operations/limits": "/docs/guides/plans-and-limits",
      "/docs/hosting": "/docs/guides/mount-the-handler",
      "/docs/hosting/client": "/docs/guides/chat-ui",
      "/docs/connections": "/docs/guides/connections",
      "/docs/channels": "/docs/guides/channels",
      "/docs/extensions": "/docs/guides/write-an-extension",
      "/docs/cookbook": "/docs/guides",
      "/docs/cookbook/approvals": "/docs/guides/approvals",
      "/docs/cookbook/scheduled-brief": "/docs/guides/scheduled-brief",
    };
    return Object.entries(moved).flatMap(([source, destination]) => [
      { source, destination, permanent: true },
      { source: `${source}.md`, destination: `${destination}.md`, permanent: true },
    ]);
  },
  // `append .md to any docs URL` — the contract llms.txt advertises.
  async rewrites() {
    return [
      { source: "/docs.md", destination: "/docs-markdown/index" },
      { source: "/docs/:slug*.md", destination: "/docs-markdown/:slug*" },
    ];
  },
};

export default createMDX()(config);
