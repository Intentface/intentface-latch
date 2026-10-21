/**
 * The `description` from a Markdown file's YAML frontmatter, as skills carry
 * it (`---\nname: refunds\ndescription: When a customer asks…\n---`). Only the
 * simple `key: value` form; quotes around the value are removed.
 */
export function frontmatterDescription(markdown: string): string | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!m) return undefined;
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^description:\s*(.*)$/.exec(line);
    if (kv) {
      const value = kv[1]!.trim().replace(/^(['"])(.*)\1$/, "$2");
      return value || undefined;
    }
  }
  return undefined;
}
