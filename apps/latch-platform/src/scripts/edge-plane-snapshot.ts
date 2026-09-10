/**
 * Edge Eval v0 — snapshot the horizontal (client-context) plane, READ-ONLY.
 *
 * The eval runs against the live `edge-client` workspace as it is (user decision
 * 2026-09-10): no wipe, no reseed. Every write tool is approval-gated and the sweep
 * runs `blockGated: true`, so the agent cannot change the workspace mid-sweep. What
 * we need instead is attribution: a content hash of `edge/` at sweep start
 * (`horizontal_ctx_version`), asserted unchanged at sweep end.
 *
 *   node --env-file=.env --import tsx src/scripts/edge-plane-snapshot.ts            # hash + write fixtures snapshot
 *   node --env-file=.env --import tsx src/scripts/edge-plane-snapshot.ts --verify   # hash live, diff against fixtures, exit 1 on drift
 *   node --env-file=.env --import tsx src/scripts/edge-plane-snapshot.ts --hash-only
 *
 * Env: LOREDEX_EVAL_WS_ID, LOREDEX_EVAL_API_KEY (only GET requests are made),
 * LOREDEX_BASE_URL (default https://app.loredex.ai).
 *
 * Loredex prepends an auto-generated `index_terms` frontmatter block to indexed files;
 * it is stripped before hashing so the version tracks authored content only.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const FIXTURES = resolve("src/evals/edge/fixtures/client-plane");
const PLANE_ROOT = "edge";
const INDEX_FRONTMATTER = /^---\n(?:index_terms:[\s\S]*?\n)?index_version:[^\n]*\n---\n/;

type Folder = { id: string; name: string; isRoot?: boolean; subfolders: Folder[]; files: FileItem[] };
type FileItem = { id: string; name: string; type: string; subtype: string | null; version: number };
type PlaneFile = { path: string; content: string; id: string; version: number };

/** sha256 over (path + content) of every file — the plane's version id. */
export function planeVersion(files: Array<[string, string]>): string {
  const h = createHash("sha256");
  for (const [p, c] of [...files].sort((a, b) => a[0].localeCompare(b[0]))) h.update(p).update("\0").update(c).update("\0");
  return h.digest("hex");
}

/** The committed snapshot, as [relative path, content]. */
export function fixtureFiles(root = FIXTURES): Array<[string, string]> {
  const walk = (dir: string): Array<[string, string]> =>
    readdirSync(dir)
      .sort()
      .flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : [[relative(root, p), readFileSync(p, "utf8")] as [string, string]];
      });
  const planeDir = join(root, PLANE_ROOT);
  return existsSync(planeDir) ? walk(planeDir) : []; // `relative(root, …)` already yields `edge/…`
}

/** Read every authored file under `edge/` from the live workspace. GET only. */
export async function readLivePlane(): Promise<{ workspace: string; files: PlaneFile[] }> {
  const wsId = process.env.LOREDEX_EVAL_WS_ID;
  const key = process.env.LOREDEX_EVAL_API_KEY;
  const base = (process.env.LOREDEX_BASE_URL ?? "https://app.loredex.ai").replace(/\/$/, "");
  if (!wsId || !key) throw new Error("LOREDEX_EVAL_WS_ID and LOREDEX_EVAL_API_KEY are required");
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${base}/api/v1/workspaces/${wsId}${path}`, { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  const ws = await get<{ data: { name: string; folders: Folder[] } }>("");
  const edge =
    ws.data.folders.find((f) => f.name === PLANE_ROOT) ??
    ws.data.folders.flatMap((r) => r.subfolders).find((f) => f.name === PLANE_ROOT);
  if (!edge) throw new Error(`no ${PLANE_ROOT}/ folder in workspace ${wsId}`);

  const files: PlaneFile[] = [];
  const collect = async (folder: Folder, prefix: string) => {
    // The tree omits `version`; the folder listing carries the full FileItem.
    const listed = await get<{ data: FileItem[] }>(`/files?folderId=${folder.id}`);
    for (const f of listed.data.sort((a, b) => a.name.localeCompare(b.name))) {
      if (f.subtype === "index") continue; // Loredex-managed folder index, not authored content
      const body = await get<{ data: { content?: string } | string }>(`/files/${f.id}/content`);
      const raw = typeof body.data === "string" ? body.data : (body.data.content ?? "");
      const name = f.name.endsWith(f.type) ? f.name : `${f.name}${f.type === ".md" ? ".md" : ""}`;
      files.push({ path: `${prefix}${name}`, content: raw.replace(INDEX_FRONTMATTER, ""), id: f.id, version: f.version });
    }
    for (const s of folder.subfolders) await collect(s, `${prefix}${s.name}/`);
  };
  await collect(edge, `${PLANE_ROOT}/`);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { workspace: ws.data.name, files };
}

async function main() {
  const hashOnly = process.argv.includes("--hash-only");
  const verify = process.argv.includes("--verify");
  const { workspace, files } = await readLivePlane();
  const live: Array<[string, string]> = files.map((f) => [f.path, f.content]);
  const version = planeVersion(live);
  console.log(`[snapshot] "${workspace}" · ${files.length} files under ${PLANE_ROOT}/ · horizontal_ctx_version=${version.slice(0, 16)}`);
  for (const f of files) console.log(`[snapshot]   ${f.path} (${f.content.length} chars, v${f.version})`);
  if (hashOnly) return console.log(`[snapshot] ${version}`);

  if (verify) {
    const committed = fixtureFiles();
    const committedVersion = planeVersion(committed);
    if (committedVersion === version) return console.log(`[snapshot] verify ✓ live plane matches the committed snapshot`);
    const liveMap = new Map(live);
    const commMap = new Map(committed);
    for (const p of new Set([...liveMap.keys(), ...commMap.keys()])) {
      if (!liveMap.has(p)) console.error(`[snapshot]   − ${p} (only in snapshot)`);
      else if (!commMap.has(p)) console.error(`[snapshot]   + ${p} (only live)`);
      else if (liveMap.get(p) !== commMap.get(p)) console.error(`[snapshot]   ~ ${p} (content differs)`);
    }
    console.error(`[snapshot] verify ✗ live ${version.slice(0, 16)} ≠ snapshot ${committedVersion.slice(0, 16)}`);
    process.exit(1);
  }

  // Write the snapshot: replace the committed tree so deletions show up in git too.
  rmSync(join(FIXTURES, PLANE_ROOT), { recursive: true, force: true });
  for (const f of files) {
    const out = join(FIXTURES, f.path);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, f.content);
  }
  const manifest = {
    client: "TwentyOne",
    description:
      "Read-only SNAPSHOT of the live edge-client workspace's edge/ tree (horizontal plane), taken by src/scripts/edge-plane-snapshot.ts. Used for case authoring, diffing and horizontal_ctx_version — never seeded back. The eval runs against the live workspace as it is.",
    workspace: { name: workspace, id: process.env.LOREDEX_EVAL_WS_ID },
    capturedAt: new Date().toISOString().slice(0, 10),
    horizontal_ctx_version: version,
    files: Object.fromEntries(files.map((f) => [f.path, { fileId: f.id, version: f.version, chars: f.content.length }])),
    normalization: "Loredex-generated index_terms/index_version frontmatter stripped; folder index.md files excluded.",
  };
  writeFileSync(join(FIXTURES, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[snapshot] wrote ${files.length} files + manifest.json to ${FIXTURES}`);
}

if (process.argv[1] && /edge-plane-snapshot\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error("[snapshot] failed:", e);
    process.exit(1);
  });
}
