/**
 * Edge Eval v0 — fingerprint the vertical (knowledge) plane, READ-ONLY.
 *
 * The sibling of `edge-plane-snapshot.ts`. The horizontal plane is hashed over REST with a
 * workspace key; the vertical plane lives in `edge-base` behind the SCOPED `edge-v2-kn`
 * endpoint (read-only, no bulk export, no workspace key here), so it is hashed through the
 * eval principal's connection — the same path the agents and the judge read it by, which is
 * the point: what is hashed is exactly what the arms saw.
 *
 *   node --env-file=.env --import tsx src/scripts/edge-vertical-snapshot.ts            # hash live, write the manifest
 *   node --env-file=.env --import tsx src/scripts/edge-vertical-snapshot.ts --verify   # compare with the committed manifest, exit 1 on drift
 *
 * The hashed set is what the prompt actually routes to: one playbook per Tier-1 pillar plus
 * the peer-examples catalog. Content is hashed, never copied into the repo (the manifest
 * holds paths, sizes and hashes only) — `edge-base` is house material, same rule as the
 * client plane.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getLatch } from "../lib/latch";
import type { Principal } from "../lib/session";
import { PILLAR_FOR, type Category } from "../evals/edge/judge/rubric";
import { CONNECTIONS } from "../evals/edge/variants";
import { readViaConnection, type Dynamic, type Opened } from "../evals/edge/judge/reference";
import { INDEX_FRONTMATTER, planeVersion } from "./edge-plane-snapshot";
import { evalPrincipal } from "./edge-connections";

export const VERTICAL_MANIFEST = resolve("src/evals/edge/fixtures/vertical-plane/manifest.json");
export const CATALOG_PATH = "edge-kn/examples/catalog.md";

/** Every file the vertical plane contributes to an answer: the four pillar playbooks + the catalog. */
export const VERTICAL_FILES: string[] = [
  ...(Object.values(PILLAR_FOR) as string[]).sort().map((p) => `edge-kn/kn/${p}/playbook.md`),
  CATALOG_PATH,
];

export interface VerticalManifest {
  plane: "vertical";
  description: string;
  connection: string;
  capturedAt: string;
  vertical_ctx_version: string;
  files: Record<string, { chars: number; lines: number; sha256: string }>;
  pillars: Record<string, string>;
  normalization: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Read the hashed set through an OPEN `edge-v2-kn` connection. GET-equivalent: read_file only. */
export async function readLiveVertical(kn: Opened): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  for (const path of VERTICAL_FILES) {
    const content = (await readViaConnection(kn, `${CONNECTIONS.kn}_read_file`, path)).replace(INDEX_FRONTMATTER, "");
    files.push({ path, content });
  }
  return files;
}

/** Open the connection, read the set, hash it. The one call the runner and the snapshot share. */
export async function verticalPlaneVersion(dynamic: Dynamic, principal: Principal): Promise<{ version: string; files: Array<{ path: string; content: string }> }> {
  const kn = await dynamic.hostFor([CONNECTIONS.kn]).open(principal);
  try {
    const files = await readLiveVertical(kn);
    return { version: planeVersion(files.map((f) => [f.path, f.content])), files };
  } finally {
    await kn.close();
  }
}

/** The committed manifest (hashes only, never content). */
export function readVerticalManifest(path = VERTICAL_MANIFEST): VerticalManifest | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as VerticalManifest) : undefined;
}

async function main() {
  const verify = process.argv.includes("--verify");
  const principal = await evalPrincipal();
  const { dynamic } = await getLatch();
  const { version, files } = await verticalPlaneVersion(dynamic as unknown as Dynamic, principal);
  console.log(`[vertical] ${files.length} files via ${CONNECTIONS.kn} · vertical_ctx_version=${version.slice(0, 16)}`);
  for (const f of files) console.log(`[vertical]   ${f.path} (${f.content.length} chars, ${f.content.split("\n").length} lines)`);

  const manifest: VerticalManifest = {
    plane: "vertical",
    description:
      "Fingerprint of the vertical (knowledge) plane as the arms see it: the four Tier-1 pillar playbooks plus the peer-examples catalog, read through the read-only edge-v2-kn scope. Hashes only — no content is copied into the repo. Written by src/scripts/edge-vertical-snapshot.ts; --verify compares the live plane against it; the sweep re-checks it at start and end.",
    connection: `${CONNECTIONS.kn} → edge-base (ws_tRUBqZ-dKZDFalqejsUrs), scope edge-kn/`,
    capturedAt: new Date().toISOString().slice(0, 10),
    vertical_ctx_version: version,
    files: Object.fromEntries(files.map((f) => [f.path, { chars: f.content.length, lines: f.content.split("\n").length, sha256: sha256(f.content) }])),
    pillars: Object.fromEntries(Object.entries(PILLAR_FOR) as Array<[Category, string]>),
    normalization: "Loredex read_file line-number prefixes and index_terms/index_version frontmatter stripped.",
  };

  if (verify) {
    const committed = readVerticalManifest();
    if (!committed) throw new Error(`no committed manifest at ${VERTICAL_MANIFEST} — run without --verify first`);
    if (committed.vertical_ctx_version === version) return console.log(`[vertical] verify ✓ live plane matches the committed manifest (${committed.capturedAt})`);
    for (const p of new Set([...Object.keys(manifest.files), ...Object.keys(committed.files)])) {
      const live = manifest.files[p];
      const was = committed.files[p];
      if (!live) console.error(`[vertical]   − ${p} (in manifest, not live)`);
      else if (!was) console.error(`[vertical]   + ${p} (live, not in manifest)`);
      else if (live.sha256 !== was.sha256) console.error(`[vertical]   ~ ${p} (${was.chars} → ${live.chars} chars)`);
    }
    console.error(`[vertical] verify ✗ live ${version.slice(0, 16)} ≠ manifest ${committed.vertical_ctx_version.slice(0, 16)}`);
    process.exit(1);
  }

  mkdirSync(dirname(VERTICAL_MANIFEST), { recursive: true });
  writeFileSync(VERTICAL_MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[vertical] wrote manifest (${files.length} files, no content) to ${VERTICAL_MANIFEST}`);
}

if (process.argv[1] && /edge-vertical-snapshot\.ts$/.test(process.argv[1])) {
  main()
    .catch((e) => {
      console.error("[vertical] failed:", e);
      process.exitCode = 1;
    })
    .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
}
