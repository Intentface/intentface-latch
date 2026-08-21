/**
 * Publish-shape check: packs every publishable package and asserts that what
 * actually ships is resolvable.
 *
 * The bug class this exists for is invisible in a monorepo. Each package's
 * `exports` map carries a `development` condition pointing at `./src/*.ts` so
 * workspace consumers get live source — but `files` is `["dist"]`, so `src` is
 * not in the tarball. A consumer whose bundler resolves that condition (Vite in
 * dev mode) imports a file that does not exist. Every local test passes; only
 * installs from the registry break.
 *
 * `publishConfig.exports` (swapped in by pnpm at pack time) strips the condition.
 * Nothing enforces that the two maps agree, so this script re-derives the truth
 * from the tarball rather than the source manifest.
 *
 * Run: `pnpm verify:publish`
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REGISTRY = "https://npm.pkg.github.com";
const out = mkdtempSync(join(tmpdir(), "latch-pack-"));
let failures = 0;

/** Every string leaf of an exports map, at any condition depth. */
function exportTargets(node, acc = []) {
  if (typeof node === "string") {
    acc.push(node);
    return acc;
  }
  if (node && typeof node === "object") {
    for (const value of Object.values(node)) exportTargets(value, acc);
  }
  return acc;
}

try {
  for (const dir of readdirSync("packages")) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(`packages/${dir}/package.json`, "utf8"));
    } catch {
      continue;
    }
    if (pkg.private) {
      console.log(`· ${pkg.name} — private, not published`);
      continue;
    }

    execSync(`pnpm pack --pack-destination ${out}`, {
      cwd: `packages/${dir}`,
      stdio: "ignore",
    });
    const tarball = join(
      out,
      `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`,
    );
    const files = execSync(`tar -tzf ${tarball}`, { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((f) => f.replace(/^package\//, ""));
    // The manifest as published — publishConfig overrides already applied.
    const shipped = JSON.parse(
      execSync(`tar -xzOf ${tarball} package/package.json`, { encoding: "utf8" }),
    );

    const problems = [];

    if (JSON.stringify(shipped.exports ?? {}).includes('"development"')) {
      problems.push(
        "exports still carries a `development` condition — add or update publishConfig.exports",
      );
    }
    for (const target of exportTargets(shipped.exports)) {
      if (!target.startsWith("./")) continue;
      if (!files.includes(target.slice(2))) {
        problems.push(`exports → ${target} is not in the tarball`);
      }
    }
    for (const field of ["main", "module", "types"]) {
      const value = shipped[field];
      if (
        typeof value === "string" &&
        value.startsWith("./") &&
        !files.includes(value.slice(2))
      ) {
        problems.push(`${field} → ${value} is not in the tarball`);
      }
    }
    // GitHub Packages links a package to its repo through this field.
    if (!shipped.repository?.directory) {
      problems.push("no repository.directory");
    }
    if (shipped.publishConfig?.registry !== REGISTRY) {
      problems.push(`publishConfig.registry is not ${REGISTRY}`);
    }

    if (problems.length > 0) {
      failures++;
      console.log(`✗ ${pkg.name}`);
      for (const problem of problems) console.log(`    ${problem}`);
    } else {
      console.log(
        `✓ ${pkg.name} — ${files.length} files, ${exportTargets(shipped.exports).length} export targets resolve`,
      );
    }
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} package(s) would ship broken.`);
  process.exit(1);
}
console.log("\nAll packages ship a resolvable export map.");
