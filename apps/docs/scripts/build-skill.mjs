// Copies a chosen set of docs pages into the Latch skill
// (skills/latch/references/), as plain markdown a coding agent can read
// offline, matching the version it installed. The skill's SKILL.md is written
// by hand and links into these files; this script fails if one of those links
// points at a page it didn't write.
//
// Run with `pnpm --filter docs skill` after changing a page listed in PAGES.
// It reads the type tables rendered by scripts/type-tables.mjs, which the
// `skill` script runs first.
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const contentDir = path.join(root, "content", "docs");
const skillDir = path.resolve(root, "../../skills/latch");
const outDir = path.join(skillDir, "references");
const SITE = (process.env.NEXT_PUBLIC_DOCS_URL || "https://intentface-latch-docs.vercel.app").replace(/\/+$/, "");

// The pages the skill carries: setting up, the basic features, and the
// reference for the options those use. Paths under content/docs, no extension.
const PAGES = [
  "getting-started/quickstart",
  "getting-started/install",
  "getting-started/by-hand",
  "concepts/inputs",
  "concepts/agents",
  "concepts/tools-connections",
  "concepts/secrets",
  "concepts/storage",
  "concepts/channels",
  "guides/chat-ui",
  "guides/mount-the-handler",
  "guides/approvals",
  "guides/schedules",
  "guides/connections",
  "guides/channels",
  "guides/plans-and-limits",
  "guides/crash-recovery",
  "guides/deploy-on-vercel",
  "guides/ownership-patterns",
  "guides/agent-for-your-customers",
  "guides/agents-in-a-database",
  "guides/storage-adapter",
  "guides/write-an-extension",
  "reference/create-runtime",
  "reference/define-agent",
  "reference/context",
  "reference/runtime",
  "reference/server",
  "reference/vault",
  "reference/errors",
];

// Components with no markdown form of their own.
const STATIC = {
  // components/docs/inputs-timeline.tsx, as a table.
  InputsTimeline: [
    "| Input | 1. First message | 2. Approved in Slack | 3. Server crashed | 4. Next message |",
    "| --- | --- | --- | --- | --- |",
    "| `principal` (who is asking) | you pass it, from your login | Latch restores it, re-checked first | Latch restores it, re-checked first | you pass it, from your login |",
    "| `context` (what they can work with) | rebuilt from the principal | rebuilt: current plan, roles | rebuilt: current plan, roles | rebuilt from the principal |",
    "| `params` (what the chat is about) | you pass it, saved on the chat | Latch restores it from the chat | Latch restores it from the chat | Latch restores it, not sent again |",
    "| `data-context` (what they're looking at) | you pass it on the message | Latch restores it: same message, same values | Latch restores it: same message, same values | you pass it: the new message's own |",
    "",
    "Your code supplies inputs only on new messages. In moments 2 and 3 nothing of yours runs except your `context` function, so everything else has to come from what Latch saved.",
  ].join("\n"),
};

const tables = JSON.parse(await readFile(path.join(root, "lib", "type-tables.generated.json"), "utf8"));
const included = new Set(PAGES);

/** `/docs/a/b#x` as seen from `from`: a relative link if the skill carries the page, else the site. */
function rewriteLink(href, from) {
  const [pathname, hash = ""] = href.split("#");
  const slug = pathname.replace(/^\/docs\/?/, "").replace(/\/$/, "");
  const anchor = hash ? `#${hash}` : "";
  if (included.has(slug)) {
    let rel = path.relative(path.dirname(from), `${slug}.md`);
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return `${rel}${anchor}`;
  }
  return `${SITE}${pathname}${anchor}`;
}

/** Turns one page's MDX into plain markdown, leaving code blocks alone. */
function toMarkdown(mdx, page) {
  // Code blocks are masked first, so nothing below touches them.
  const blocks = [];
  let text = mdx.replace(/^(\s*)(`{3,}|~{3,})[\s\S]*?^\1\2\s*$/gm, (block) => `\u0000${blocks.push(block) - 1}\u0000`);

  text = text
    .replace(/<auto-type-table\s+path="([^"]+)"\s+name="([^"]+)"\s*\/>/g, (tag, rel, name) => {
      const table = tables[`${rel}#${name}`];
      if (!table) throw new Error(`${page}: no rendered table for ${rel}#${name}; run scripts/type-tables.mjs`);
      return table;
    })
    .replace(/<([A-Z]\w*)\s*\/>/g, (tag, name) => {
      if (!(name in STATIC)) throw new Error(`${page}: no markdown form for <${name} />; add one to STATIC`);
      return STATIC[name];
    })
    // A callout becomes a quoted block under its title.
    .replace(/<Callout([^>]*)>([\s\S]*?)<\/Callout>/g, (_, attrs, body) => {
      const title = attrs.match(/title="([^"]*)"/)?.[1];
      const lines = [title ? `**${title}**` : null, title ? "" : null, ...body.trim().split("\n")].filter((l) => l !== null);
      return lines.map((l) => (l ? `> ${l}` : ">")).join("\n");
    })
    // Tabs become one bold heading per tab.
    .replace(/<Tabs[^>]*>\n?/g, "")
    .replace(/<\/Tabs>\n?/g, "")
    .replace(/<Tab\s+value="([^"]*)"\s*>/g, "**$1**\n")
    .replace(/<\/Tab>/g, "")
    // Cards become a list of links.
    .replace(/<Cards>\n?/g, "")
    .replace(/<\/Cards>\n?/g, "")
    .replace(
      /<Card\s+href="([^"]+)"\s+title="([^"]+)"(?:\s+description="([^"]*)")?\s*\/>/g,
      (_, href, title, description) => `- [${title}](${href})${description ? `: ${description}` : ""}`,
    )
    .replace(/\]\((\/docs[^)\s]*)\)/g, (_, href) => `](${rewriteLink(href, page)})`)
    .replace(/\n{3,}/g, "\n\n");

  // Inline code (`Runtime<P>`) is code, not a component.
  const leftover = text.replace(/`[^`\n]*`/g, "").match(/<\/?[A-Z]\w*[^>]*>/);
  if (leftover) throw new Error(`${page}: unconverted component ${leftover[0]}`);
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}

await rm(outDir, { recursive: true, force: true });
for (const page of PAGES) {
  const raw = await readFile(path.join(contentDir, `${page}.mdx`), "utf8");
  const front = raw.match(/^---\n([\s\S]*?)\n---\n/);
  const field = (name) => front?.[1].match(new RegExp(`^${name}:\\s*(.*)$`, "m"))?.[1].trim();
  const body = toMarkdown(raw.slice(front ? front[0].length : 0), page);
  const doc = [
    `<!-- Generated from apps/docs/content/docs/${page}.mdx by apps/docs/scripts/build-skill.mjs. Edit the page, not this file. -->`,
    "",
    `# ${field("title")}`,
    "",
    field("description") ? `${field("description")}\n` : null,
    `Online: ${SITE}/docs/${page}`,
    "",
    body.trim(),
    "",
  ].filter((l) => l !== null);
  const file = path.join(outDir, `${page}.md`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, doc.join("\n"));
}

// Every reference SKILL.md links to must be one written above.
const skill = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
const missing = [...skill.matchAll(/\]\((references\/[^)#\s]+)/g)]
  .map(([, href]) => href.replace(/^references\//, "").replace(/\.md$/, ""))
  .filter((slug) => !included.has(slug));
if (missing.length) throw new Error(`SKILL.md links to references not in PAGES: ${missing.join(", ")}`);

const written = await readdir(outDir, { recursive: true });
console.log(`skill: ${written.filter((f) => f.endsWith(".md")).length} references written to ${path.relative(process.cwd(), outDir)}`);
