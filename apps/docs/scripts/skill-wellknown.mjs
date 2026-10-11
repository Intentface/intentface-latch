// Serves the Latch agent skill from the docs site, so it installs with
//   npx skills add https://<docs-site>
// The skills CLI looks for /.well-known/agent-skills/index.json (agent skills
// discovery, schema 0.2.0): an entry per skill with an archive URL and its
// sha256. This packs skills/latch into public/.well-known/agent-skills/ as a
// .tar.gz with SKILL.md at its root, and writes the index next to it.
//
// Runs before `next dev` and `next build`; the output is generated, not
// committed. The archive is written by hand (ustar + gzip) rather than with
// the `tar` binary, whose flags differ between macOS and the build machines,
// and with fixed timestamps, so the same skill always gives the same digest.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const skillDir = path.resolve(root, "../../skills/latch");
const outDir = path.join(root, "public", ".well-known", "agent-skills");
const SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

/** Every file under `dir`, as [path relative to it, contents], sorted. */
async function filesOf(dir) {
  const names = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
    .sort();
  return Promise.all(names.map(async (name) => [name, await readFile(path.join(dir, name))]));
}

/** A 512-byte ustar header for a regular file. */
function tarHeader(name, size) {
  if (Buffer.byteLength(name) > 100) throw new Error(`skill path too long for the archive: ${name}`);
  const h = Buffer.alloc(512);
  const put = (text, offset, length) => h.write(text, offset, length, "ascii");
  const octal = (n, length) => n.toString(8).padStart(length - 1, "0");
  h.write(name, 0, 100, "utf8");
  put(octal(0o644, 8), 100, 8); // mode
  put(octal(0, 8), 108, 8); // uid
  put(octal(0, 8), 116, 8); // gid
  put(octal(size, 12), 124, 12); // size
  put(octal(0, 12), 136, 12); // mtime: fixed, so the digest only changes with the content
  h.fill(0x20, 148, 156); // checksum field counts as spaces while summing
  put("0", 156, 1); // regular file
  put("ustar\u000000", 257, 8); // magic + version
  let sum = 0;
  for (const byte of h) sum += byte;
  put(`${octal(sum, 7)}\u0000 `, 148, 8);
  return h;
}

function tar(files) {
  const blocks = [];
  for (const [name, content] of files) {
    blocks.push(tarHeader(name, content.length), content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024)); // end of archive
  return Buffer.concat(blocks);
}

const files = await filesOf(skillDir);
const skillMd = files.find(([name]) => name === "SKILL.md")?.[1].toString("utf8");
if (!skillMd) throw new Error(`no SKILL.md in ${skillDir}`);
const frontmatter = skillMd.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
const field = (key) => frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1].trim();
const name = field("name");
const description = field("description");
if (!name || !description) throw new Error("SKILL.md needs a name and a description in its frontmatter");

const archive = gzipSync(tar(files), { level: 9 });
const digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, `${name}.tar.gz`), archive);
await writeFile(
  path.join(outDir, "index.json"),
  `${JSON.stringify({ $schema: SCHEMA, skills: [{ name, type: "archive", description, url: `${name}.tar.gz`, digest }] }, null, 2)}\n`,
);
console.log(`agent skill: ${name} (${files.length} files, ${archive.length} bytes) at /.well-known/agent-skills/`);
