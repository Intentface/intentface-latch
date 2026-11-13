/**
 * The `description` from a Markdown file's YAML frontmatter, as skills carry
 * it (`---\nname: refunds\ndescription: When a customer asks…\n---`). Only the
 * simple `key: value` form; quotes around the value are removed.
 */
export function frontmatterDescription(markdown: string): string | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!m) return undefined;
  for (const line of m[1]!.split(/\r?\n/)) {
    if (line.startsWith("description:")) {
      const value = unquote(line.slice("description:".length).trim());
      return value || undefined;
    }
  }
  return undefined;
}

const unquote = (v: string) => (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0] ? v.slice(1, -1) : v);
