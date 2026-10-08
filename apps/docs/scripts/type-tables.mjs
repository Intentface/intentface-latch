// Renders every `<auto-type-table path=… name=… />` in the docs to a markdown
// table, for the markdown views of the docs (`/docs/….md`, `/llms-full.txt`).
// The HTML pages render the same tables at build time through the remark
// plugin in source.config.ts; this is the plain-text twin, so an agent reading
// the docs as markdown gets every parameter too. Runs before `next dev` and
// `next build`; the output is a generated file, not committed.
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGenerator } from "fumadocs-typescript";

const root = path.resolve(import.meta.dirname, "..");
const contentDir = path.join(root, "content", "docs");
const out = path.join(root, "lib", "type-tables.generated.json");
const TAG = /<auto-type-table\s+path="([^"]+)"\s+name="([^"]+)"\s*\/>/g;

const generator = createGenerator({ tsconfigPath: path.resolve(root, "../../packages/core/tsconfig.json") });

async function* mdxFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* mdxFiles(full);
    else if (entry.name.endsWith(".mdx")) yield full;
  }
}

const cell = (text) => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();

function table(entries) {
  const rows = entries.map((e) => {
    const def = e.tags.find((t) => t.name === "default" || t.name === "defaultValue")?.text;
    const name = `\`${e.name}\`${e.required ? "" : " (optional)"}`;
    const type = `\`${e.type.replace(/ \| undefined$/, "")}\``;
    const desc = [e.description, def ? `Default: \`${def}\`.` : ""].filter(Boolean).join(" ");
    return `| ${cell(name)} | ${cell(type)} | ${cell(desc)} |`;
  });
  return ["| Option | Type | Description |", "| --- | --- | --- |", ...rows].join("\n");
}

const tables = {};
for await (const file of mdxFiles(contentDir)) {
  const text = await readFile(file, "utf8");
  for (const [, rel, name] of text.matchAll(TAG)) {
    const source = path.resolve(path.dirname(file), rel);
    const [doc] = await generator.generateDocumentation({ path: source }, name);
    if (!doc) throw new Error(`${path.relative(root, file)}: no exported type ${name} in ${rel}`);
    tables[`${rel}#${name}`] = table(doc.entries);
  }
}
await writeFile(out, JSON.stringify(tables, null, 2) + "\n");
console.log(`type tables: ${Object.keys(tables).length} rendered to ${path.relative(root, out)}`);
