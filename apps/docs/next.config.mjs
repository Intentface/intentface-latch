import { createMDX } from "fumadocs-mdx/next";

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // The docs read source files (see app/docs-markdown) at request time.
  outputFileTracingIncludes: {
    "/docs-markdown/**": ["./content/docs/**/*"],
    "/llms-full.txt": ["./content/docs/**/*"],
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
