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
 * The same reasoning covers internal dependency ranges: `workspace:*` and
 * `workspace:^` are indistinguishable in the workspace and produce very
 * different consumer installs, so that is checked from the tarball too.
 *
 * Run: `pnpm verify:publish`
 */
import { execFileSync, execSync } from "node:child_process";
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REGISTRY = "https://registry.npmjs.org";
/**
 * There is ONE LICENSE, at the workspace root. `pnpm pack` copies it into every
 * package tarball, so no per-package copies exist to drift. That convenience is
 * pnpm's, not npm's — publish with bare `npm publish` and the tarballs would
 * assert MIT while shipping no license text, which is why the check below reads
 * the packed tarball rather than the directory.
 */
const LICENSE = readFileSync("LICENSE", "utf8");
const out = mkdtempSync(join(tmpdir(), "latch-pack-"));
/**
 * Package names in this workspace — the set the range rule applies to. Derived
 * rather than matched on the `@intentface/` prefix, which also covers packages
 * published from other repositories.
 */
const workspaceNames = new Set(
  readdirSync("packages").flatMap((dir) => {
    try {
      return [JSON.parse(readFileSync(`packages/${dir}/package.json`, "utf8")).name];
    } catch {
      return [];
    }
  }),
);
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

    // Compiled tests ship when a package's tsconfig doesn't exclude them.
    const tests = files.filter((f) => /\.test\.(js|d\.ts|js\.map|d\.ts\.map)$/.test(f) || f.includes("__tests__/"));
    if (tests.length) {
      problems.push(`ships ${tests.length} test file(s), e.g. ${tests[0]} — exclude src/**/*.test.ts in tsconfig.json`);
    }

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
    // Existing is not the same as loadable. A `.js` target whose own relative
    // imports lack the `.js` extension compiles clean (`moduleResolution:
    // "Bundler"` accepts them, and tsc never rewrites specifiers) and then
    // fails at import in Node ESM with ERR_MODULE_NOT_FOUND — which is how
    // latch-agent-builder 0.9.1 shipped unimportable. So import every JS
    // target for real, from the built `dist` the tarball is packed from (the
    // package's dependencies resolve there; they would not inside the tarball).
    for (const target of new Set(exportTargets(shipped.exports))) {
      if (!target.startsWith("./") || !target.endsWith(".js")) continue;
      const file = pathToFileURL(resolve(`packages/${dir}`, target)).href;
      try {
        // An argument array, not a shell string: the URL carries quotes.
        execFileSync(
          process.execPath,
          ["--input-type=module", "-e", `await import(${JSON.stringify(file)})`],
          { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
        );
      } catch (error) {
        const stderr = String(error.stderr ?? "");
        const code = stderr.match(/code: '([A-Z_]+)'/)?.[1] ?? "import failed";
        const what = stderr.match(/Cannot find module '([^']+)'/)?.[1];
        problems.push(
          `exports → ${target} does not load in Node ESM (${code}${what ? `: ${what.replace(process.cwd(), ".")}` : ""})`,
        );
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
    // Internal deps must publish as CARET RANGES. `workspace:*` rewrites to an
    // exact pin, so a consumer on `^0.1.0` who resolves core to 0.1.1 gets a
    // second, nested copy of core to satisfy a sibling's `0.1.0` — two module
    // registries, two sets of instanceof identities, no error. `workspace:^`
    // publishes `^0.1.0` and dedupes. See RELEASING.md.
    //
    // Requiring a leading `^` rather than merely rejecting a leading digit: the
    // policy is `workspace:^`, and this also catches `=0.1.0` (a hand-written
    // exact pin pnpm ships untouched) and `~0.1.0`.
    //
    // Peers are checked too — an internal package added as a `workspace:*` peer
    // rewrites to an exact pin exactly the same way.
    //
    // Scoped to THIS workspace's names, not the whole @intentface scope:
    // `@intentface/chat` is published from another repository, so "use
    // workspace:^" would be impossible advice for it.
    for (const field of ["dependencies", "peerDependencies"]) {
      for (const [name, range] of Object.entries(shipped[field] ?? {})) {
        if (!workspaceNames.has(name)) continue;
        if (!range.startsWith("^")) {
          problems.push(
            `${field}.${name} ships as "${range}" — must be a caret range; use workspace:^ in package.json`,
          );
        }
      }
    }
    // npm renders the repo link from this field, and monorepo tooling (and
    // provenance attestation) uses `directory` to find the package's source.
    if (!shipped.repository?.directory) {
      problems.push("no repository.directory");
    }
    // A package that declares a license must ship its text.
    if (!files.includes("LICENSE")) {
      problems.push("LICENSE is not in the tarball");
    } else {
      const shippedLicense = execSync(`tar -xzOf ${tarball} package/LICENSE`, {
        encoding: "utf8",
      });
      if (shippedLicense !== LICENSE) {
        problems.push("LICENSE in the tarball differs from the root LICENSE");
      }
    }
    if (shipped.publishConfig?.registry !== REGISTRY) {
      problems.push(`publishConfig.registry is not ${REGISTRY}`);
    }

    if (problems.length > 0) {
      failures++;
      console.log(`✗ ${pkg.name}`);
      // One target can sit under several conditions; report each problem once.
      for (const problem of new Set(problems)) console.log(`    ${problem}`);
    } else {
      console.log(
        `✓ ${pkg.name} — ${files.length} files, ${exportTargets(shipped.exports).length} export targets resolve and load`,
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
