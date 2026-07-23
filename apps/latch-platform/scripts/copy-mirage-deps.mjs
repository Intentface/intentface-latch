// Postbuild: copy @struktoai/mirage-node's full dependency closure into the
// server output's node_modules.
//
// Nitro's `traceDeps` keeps mirage-node external (it loads tree-sitter .wasm
// and several deps via runtime require, which only works from a real
// node_modules layout), but the file tracer misses dynamic-require edges
// (fs-monkey, compressjs internals, …). Rather than enumerate them per mirage
// release, replicate the pnpm virtual store: copy each closure package's
// `.pnpm/<id>` entry (symlinks preserved, so every package still resolves the
// exact dep versions pnpm gave it — a flat copy would collide on packages
// needed at two versions) and point node_modules/@struktoai/mirage-node at
// the store entry. Runs after `vite build` (see package.json).
import { cp, mkdir, readdir, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = "@struktoai/mirage-node";
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** `.pnpm/<id>` store entry that contains a real package dir, or null. */
function storeEntryOf(realPkgDir) {
  const parts = realPkgDir.split(path.sep);
  const i = parts.lastIndexOf(".pnpm");
  return i === -1 ? null : parts.slice(0, i + 2).join(path.sep);
}

/**
 * BFS the dependency closure over real package dirs (a name can appear at
 * several versions — key by dir). Deps resolve as siblings in the package's
 * own virtual-store node_modules, exactly like the runtime would.
 */
async function collectClosure(rootDir) {
  const seen = new Set([rootDir]);
  const queue = [rootDir];
  while (queue.length > 0) {
    const dir = queue.shift();
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf-8"));
    const nm = pkg.name?.startsWith("@")
      ? path.dirname(path.dirname(dir))
      : path.dirname(dir);
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      const depDir = await realpath(path.join(nm, dep)).catch(() => null);
      if (!depDir || seen.has(depDir)) continue; // absent = optional/unused
      seen.add(depDir);
      queue.push(depDir);
    }
  }
  return seen;
}

const rootDir = await realpath(path.join(appDir, "node_modules", ROOT));
const entries = new Set();
for (const dir of await collectClosure(rootDir)) {
  const entry = storeEntryOf(dir);
  if (entry) entries.add(entry);
}

// Server output dirs across presets (plain node + Vercel).
const vercelFns = path.join(appDir, ".vercel/output/functions");
const serverDirs = [
  path.join(appDir, ".output/server"),
  ...(await readdir(vercelFns).catch(() => []))
    .filter((d) => d.endsWith(".func"))
    .map((d) => path.join(vercelFns, d)),
];

let targets = 0;
for (const serverDir of serverDirs) {
  if (!(await stat(serverDir).catch(() => null))) continue;
  targets++;
  const outStore = path.join(serverDir, "node_modules", ".pnpm");
  for (const entry of entries) {
    await cp(entry, path.join(outStore, path.basename(entry)), {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
    });
  }
  // Replace whatever the tracer emitted for mirage-node with a link into the
  // replicated store, so its runtime requires resolve pnpm's exact graph.
  const linkPath = path.join(serverDir, "node_modules", ROOT);
  const target = path.join(outStore, path.basename(storeEntryOf(rootDir)), "node_modules", ROOT);
  await rm(linkPath, { recursive: true, force: true });
  await mkdir(path.dirname(linkPath), { recursive: true });
  await symlink(path.relative(path.dirname(linkPath), target), linkPath, "dir");
  console.log(
    `[copy-mirage-deps] ${entries.size} store entries -> ${path.relative(appDir, serverDir)}/node_modules/.pnpm`,
  );
}
if (targets === 0) {
  console.error("[copy-mirage-deps] no server output dir found — nothing copied");
  process.exit(1);
}
