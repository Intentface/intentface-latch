/**
 * Edge Eval v0 — fingerprint the horizontal (client-context) plane, READ-ONLY.
 *
 * The eval runs against the live `edge-client` workspace exactly as it is (user
 * decision 2026-09-11): nothing in this repo may create, modify or delete anything
 * there, and no copy of its content is kept in git. Every write tool the agents get
 * is approval-gated and the sweep runs `blockGated: true`, so the agents cannot
 * change it either. What the eval needs is attribution: a content hash of `edge/`
 * at sweep start (`horizontal_ctx_version`), asserted unchanged at sweep end.
 *
 *   node --env-file=.env --import tsx src/scripts/edge-plane-snapshot.ts            # hash live, write the manifest (ids, versions, per-file hashes)
 *   node --env-file=.env --import tsx src/scripts/edge-plane-snapshot.ts --verify   # hash live, compare with the committed manifest, exit 1 on drift
 *   node --env-file=.env --import tsx src/scripts/edge-plane-snapshot.ts --hash-only
 *
 * Env: LOREDEX_EVAL_WS_ID, LOREDEX_EVAL_API_KEY (only GET requests are ever made;
 * a read-only key is enough), LOREDEX_BASE_URL (default https://app.loredex.ai).
 *
 * Loredex prepends an auto-generated `index_terms` frontmatter block to indexed files;
 * it is stripped before hashing so the version tracks authored content only.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const MANIFEST = resolve("src/evals/edge/fixtures/client-plane/manifest.json");
const PLANE_ROOT = "edge";
export const INDEX_FRONTMATTER = /^---\n(?:index_terms:[\s\S]*?\n)?index_version:[^\n]*\n---\n/;

type Folder = { id: string; name: string; isRoot?: boolean; subfolders: Folder[]; files: FileItem[] };
type FileItem = { id: string; name: string; type: string; subtype: string | null; version: number };
type PlaneFile = { path: string; content: string; id: string; version: number };

/** sha256 over (path + content) of every file — the plane's version id. */
export function planeVersion(files: Array<[string, string]>): string {
  const h = createHash("sha256");
  for (const [p, c] of [...files].sort((a, b) => a[0].localeCompare(b[0]))) h.update(p).update("\0").update(c).update("\0");
  return h.digest("hex");
}

export interface PlaneManifest {
  client: string;
  description: string;
  workspace: { name: string; id: string | undefined };
  capturedAt: string;
  horizontal_ctx_version: string;
  files: Record<string, { fileId: string; version: number; chars: number; sha256: string }>;
  normalization: string;
}

/** The committed manifest (ids, versions, hashes — never content). */
export function readManifest(path = MANIFEST): PlaneManifest | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as PlaneManifest) : undefined;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

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

  const manifest: PlaneManifest = {
    client: "TwentyOne",
    description:
      "Fingerprint of the live edge-client workspace's edge/ tree (horizontal plane): file ids, versions and content hashes only — no content is copied into the repo. Written by src/scripts/edge-plane-snapshot.ts; --verify compares the live plane against it. The eval runs against the live workspace exactly as it is and never writes to it.",
    workspace: { name: workspace, id: process.env.LOREDEX_EVAL_WS_ID },
    capturedAt: new Date().toISOString().slice(0, 10),
    horizontal_ctx_version: version,
    files: Object.fromEntries(files.map((f) => [f.path, { fileId: f.id, version: f.version, chars: f.content.length, sha256: sha256(f.content) }])),
    normalization: "Loredex-generated index_terms/index_version frontmatter stripped; folder index.md files excluded.",
  };

  if (verify) {
    const committed = readManifest();
    if (!committed) throw new Error(`no committed manifest at ${MANIFEST} — run without --verify first`);
    if (committed.horizontal_ctx_version === version) return console.log(`[snapshot] verify ✓ live plane matches the committed manifest (${committed.capturedAt})`);
    for (const p of new Set([...Object.keys(manifest.files), ...Object.keys(committed.files)])) {
      const live = manifest.files[p];
      const was = committed.files[p];
      if (!live) console.error(`[snapshot]   − ${p} (in manifest, not live)`);
      else if (!was) console.error(`[snapshot]   + ${p} (live, not in manifest)`);
      else if (live.sha256 !== was.sha256) console.error(`[snapshot]   ~ ${p} (content changed, v${was.version} → v${live.version})`);
    }
    console.error(`[snapshot] verify ✗ live ${version.slice(0, 16)} ≠ manifest ${committed.horizontal_ctx_version.slice(0, 16)}`);
    process.exit(1);
  }

  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[snapshot] wrote manifest (${files.length} files, no content) to ${MANIFEST}`);
}

if (process.argv[1] && /edge-plane-snapshot\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error("[snapshot] failed:", e);
    process.exit(1);
  });
}
