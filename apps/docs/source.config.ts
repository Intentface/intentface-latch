import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { createGenerator, remarkAutoTypeTable } from "fumadocs-typescript";

export const docs = defineDocs({ dir: "content/docs" });

/**
 * Parameter tables are generated from the packages' own TypeScript types and
 * their JSDoc (`<auto-type-table path=… name=… />`), at build time — the
 * reference can't drift from the code, and a better doc comment improves both
 * the site and editor hovers.
 */
const generator = createGenerator({ tsconfigPath: "../../packages/core/tsconfig.json" });

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

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [[remarkAutoTypeTable, { generator, options: { typeSimplifier: { override } } }]],
  },
});
