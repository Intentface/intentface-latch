import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { createGenerator, remarkAutoTypeTable } from "fumadocs-typescript";

export const docs = defineDocs({ dir: "content/docs" });

/**
 * Parameter tables are generated from the packages' own TypeScript types and
 * their JSDoc (`<auto-type-table path=… name=… />`), at build time — the
 * reference can't drift from the code, and a better doc comment improves both
 * the site and editor hovers.
 */
const generator = createGenerator({ tsconfigPath: "./tsconfig.type-tables.json" });

/** Longest type text shown as-is in the collapsed row; longer ones fall back to the default simple form. */
const SHORT = 64;

/**
 * The default simple form turns every named interface into "object", every
 * union into "union" and every callback into "function". Show the type as
 * written when it's short and has no inline object (`DurabilityConfig`,
 * `"low" | "high"`, `boolean`); the expanded row always has the full type.
 */
function override({ type, checker, location }: { type: any; checker: any; location?: any }): string | undefined {
  // An optional prop's type includes `undefined`; the `?` already says so.
  const text: string = checker.typeToString(type, location).replace(/ \| undefined$/, "");
  return text.includes("{") || text.length > SHORT ? undefined : text;
}

type MdNode = { type: string; meta?: string | null; data?: Record<string, unknown>; children?: MdNode[] };

/**
 * Keeps a fence's `title="…"` (```ts title="lib/latch.ts") as `data-title` on
 * the code element, where the `pre` handler in mdx-components.tsx reads it for
 * the code block's tab.
 */
function remarkCodeTitle() {
  const walk = (node: MdNode) => {
    if (node.type === "code" && node.meta) {
      const title = /title="([^"]+)"/.exec(node.meta)?.[1];
      if (title) {
        const data = (node.data ??= {});
        data.hProperties = { ...(data.hProperties as object | undefined), "data-title": title };
      }
    }
    node.children?.forEach(walk);
  };
  return (tree: MdNode) => walk(tree);
}

/** Types render as plain text: the table's type chip styles them. */
const renderType = async (type: string) => ({
  type: "element" as const,
  tagName: "span",
  properties: {},
  children: [{ type: "text" as const, value: type }],
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [
      remarkCodeTitle,
      [remarkAutoTypeTable, { generator, renderType, options: { typeSimplifier: { override } } }],
    ],
    // Disable fumadocs' built-in shiki pass so fenced code reaches the `pre`
    // handler as raw text. Highlighting is done in one place: the CodeBlock
    // component (fumadocs-core `highlight`).
    rehypeCodeOptions: false,
  },
});
