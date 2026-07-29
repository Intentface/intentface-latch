// Postbuild: copy the full pnpm dependency closures of packages the server
// output resolves at runtime (rather than bundling) into each server dir's
// node_modules.
//
// Nitro's `traceDeps` keeps @struktoai/mirage-node external (it loads
// tree-sitter .wasm and several deps via runtime require, which only works
// from a real node_modules layout), but the file tracer misses
// dynamic-require edges (fs-monkey, compressjs internals, …).
//
// Rather than enumerate transitive files per release, replicate the pnpm
// virtual store: copy each closure package's `.pnpm/<id>` entry (symlinks
// preserved, so every package still resolves the exact dep versions pnpm gave
// it — a flat copy would collide on packages needed at two versions) and
// point node_modules/<name> at the store entry. Runs after `vite build` (see
// package.json).
//
// To find missing externals after a build, scan the function output for bare
// import specifiers and diff against its node_modules, e.g.:
//   grep -rhoE 'from *"[^".][^"]*"' .vercel/output/functions/*.func/{_ssr,_chunks} | sort -u
import { cp, mkdir, readdir, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Each root is resolved by walking `chain` through pnpm's virtual store,
// starting from `from`'s node_modules (later steps resolve as siblings in the
// previous package's store entry — for packages that are not a direct
// dependency of any workspace package). The chain's final package gets a
// top-level node_modules/<name> symlink. Anything else the server output
// imports bare at runtime must either be listed here or bundled via
// `ssr.noExternal` (see vite.config.ts) — mind Vercel's 250 MB function
// limit before adding closures here.
const ROOTS = [{ from: appDir, chain: ["@struktoai/mirage-node"] }];

/** `.pnpm/<id>` store entry that contains a real package dir, or null. */
function storeEntryOf(realPkgDir) {
  const parts = realPkgDir.split(path.sep);
  const i = parts.lastIndexOf(".pnpm");
  return i === -1 ? null : parts.slice(0, i + 2).join(path.sep);
}

/** The node_modules dir whose entries are `realPkgDir`'s resolvable siblings. */
function siblingNmOf(realPkgDir) {
  const i = realPkgDir.lastIndexOf(`${path.sep}node_modules${path.sep}`);
  return realPkgDir.slice(0, i + `${path.sep}node_modules`.length);
}

async function resolveChain(from, chain) {
  let dir = await realpath(path.join(from, "node_modules", chain[0]));
  for (const name of chain.slice(1)) {
    dir = await realpath(path.join(siblingNmOf(dir), name));
  }
  return dir;
}

/**
 * BFS the dependency closure over real package dirs (a name can appear at
 * several versions — key by dir). Deps resolve as siblings in the package's
 * own virtual-store node_modules, exactly like the runtime would. Optional
 * and peer deps count too: @napi-rs/* platform bindings ship exclusively as
 * optionalDependencies, and absent ones just don't resolve.
 */
async function collectClosure(rootDir, seen) {
  seen.add(rootDir);
  const queue = [rootDir];
  while (queue.length > 0) {
    const dir = queue.shift();
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf-8"));
    const nm = siblingNmOf(dir);
    const deps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ];
    for (const dep of deps) {
      const depDir = await realpath(path.join(nm, dep)).catch(() => null);
      if (!depDir || seen.has(depDir)) continue; // absent = optional/unused
      seen.add(depDir);
      queue.push(depDir);
    }
  }
}

const closure = new Set();
const links = []; // [publicName, realPkgDir]
for (const root of ROOTS) {
  const dir = await resolveChain(root.from, root.chain);
  links.push([root.chain[root.chain.length - 1], dir]);
  await collectClosure(dir, closure);
}
const entries = new Set();
for (const dir of closure) {
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
  // Replace whatever the tracer emitted (or nothing) for each root with a
  // link into the replicated store, so its runtime requires resolve pnpm's
  // exact graph.
  for (const [name, dir] of links) {
    const linkPath = path.join(serverDir, "node_modules", name);
    const target = path.join(outStore, path.basename(storeEntryOf(dir)), "node_modules", name);
    await rm(linkPath, { recursive: true, force: true });
    await mkdir(path.dirname(linkPath), { recursive: true });
    await symlink(path.relative(path.dirname(linkPath), target), linkPath, "dir");
  }
  console.log(
    `[copy-server-deps] ${entries.size} store entries, ${links.length} roots -> ${path.relative(appDir, serverDir)}/node_modules`,
  );
}
if (targets === 0) {
  console.error("[copy-server-deps] no server output dir found — nothing copied");
  process.exit(1);
}
