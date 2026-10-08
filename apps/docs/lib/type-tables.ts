import tables from "./type-tables.generated.json";

const TAG = /<auto-type-table\s+path="([^"]+)"\s+name="([^"]+)"\s*\/>/g;

/**
 * Replaces each `<auto-type-table … />` in a page's source with its markdown
 * table (rendered by scripts/type-tables.mjs), for the markdown views of the
 * docs. An unknown tag is left as it is.
 */
export function expandTypeTables(mdx: string): string {
  return mdx.replace(TAG, (tag, rel: string, name: string) => (tables as Record<string, string>)[`${rel}#${name}`] ?? tag);
}
