/**
 * Edge Eval v0 — (re)seed the horizontal (client-context) plane.
 *
 * Wipes `edge/` in the eval Loredex workspace and recreates `edge/ctx/*` from
 * the committed fixture tree. `edge/memory/` is deliberately NOT created, so
 * Tier-3 memory is empty at the start of every sweep. Prints the fixture-tree
 * hash (`horizontal_ctx_version`) so the sweep can stamp it.
 *
 *   node --env-file=.env --import tsx src/scripts/edge-seed-plane.ts [--dry-run] [--hash-only]
 *
 * Env: LOREDEX_EVAL_WS_ID (ws_…), LOREDEX_EVAL_API_KEY (lrx_…, read+write+delete,
 * bound to that workspace), LOREDEX_BASE_URL (default https://app.loredex.ai).
 * Refuses to touch any workspace whose id is not the eval one.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const FIXTURES = resolve("src/evals/edge/fixtures/client-plane");
const PLANE_ROOT = "edge";
// Never seed a knowledge/inbox workspace: this script recreates `edge/` wholesale.
// (2026-09-10: the user chose to run the eval against the REAL client workspace
// ws_7e_rtGs6Hbd0IUAhJ_Pdf, so that id is deliberately NOT protected; its prior
// edge/memory/ is archived under fixtures/client-plane-archive/.)
const PROTECTED_WS = new Set(["ws_diTBvPuyFL7jHOKPJKM1S", "ws_tRUBqZ-dKZDFalqejsUrs"]);

const dryRun = process.argv.includes("--dry-run");
const hashOnly = process.argv.includes("--hash-only");

/** Every file under the fixture root, sorted, as [relative path, content]. */
function walk(dir: string, root = dir): Array<[string, string]> {
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p, root) : [[relative(root, p), readFileSync(p, "utf8")] as [string, string]];
    });
}

/** Every fixture file under `edge/`, sorted — the exact set the seed writes. */
export const fixtureFiles = (): Array<[string, string]> => walk(FIXTURES).filter(([p]) => p.startsWith(`${PLANE_ROOT}/`));

/** sha256 over (path + content) of every fixture file — the plane's version id. */
export function planeVersion(files: Array<[string, string]>): string {
  const h = createHash("sha256");
  for (const [p, c] of files) h.update(p).update("\0").update(c).update("\0");
  return h.digest("hex");
}

type Folder = { id: string; name: string; isRoot?: boolean; subfolders: Folder[]; files: Array<{ id: string; name: string }> };

async function main() {
  const files = fixtureFiles();
  const version = planeVersion(files);
  console.log(`[seed] fixtures: ${files.length} files under ${PLANE_ROOT}/ · horizontal_ctx_version=${version.slice(0, 16)}`);
  if (hashOnly) return;

  const wsId = process.env.LOREDEX_EVAL_WS_ID;
  const key = process.env.LOREDEX_EVAL_API_KEY;
  const base = (process.env.LOREDEX_BASE_URL ?? "https://app.loredex.ai").replace(/\/$/, "");
  if (!wsId || !key) throw new Error("LOREDEX_EVAL_WS_ID and LOREDEX_EVAL_API_KEY are required");
  if (PROTECTED_WS.has(wsId)) throw new Error(`refusing to seed ${wsId}: that is a knowledge/inbox plane, not the client plane`);

  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base}/api/v1/workspaces/${wsId}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };

  // 1. Current tree. `edge/` is a TOP-LEVEL folder in production (a sibling of
  //    `__shared_root`, not a child of it) — find it wherever it is and recreate it
  //    at the same level.
  const ws = await api<{ data: { name: string; folders: Folder[] } }>("GET", "");
  const roots = ws.data.folders;
  const locate = (): { folder?: Folder; parentId: string | null } => {
    const top = roots.find((f) => f.name === PLANE_ROOT);
    if (top) return { folder: top, parentId: null };
    for (const r of roots) {
      const sub = r.subfolders.find((f) => f.name === PLANE_ROOT);
      if (sub) return { folder: sub, parentId: r.id };
    }
    return { parentId: null };
  };
  const { folder: existing, parentId: edgeParentId } = locate();
  console.log(`[seed] workspace "${ws.data.name}" (${wsId}) · ${PLANE_ROOT}/ ${existing ? `exists (${existing.id}, ${edgeParentId ? "under " + edgeParentId : "top-level"})` : "absent"}`);

  // 2. Wipe edge/ (folder delete is recursive).
  if (existing) {
    const count = (f: Folder): number => f.files.length + f.subfolders.reduce((n, s) => n + count(s), 0);
    console.log(`[seed] deleting ${PLANE_ROOT}/ (${count(existing)} files incl. index files)${dryRun ? " [dry-run]" : ""}`);
    if (!dryRun) await api("DELETE", `/folders/${existing.id}`);
  }

  // 3. Recreate folders, then files (create-with-content publishes directly;
  //    PUT /content would only write a draft).
  const folderIds = new Map<string, string | null>([["", edgeParentId]]);
  const ensureFolder = async (path: string): Promise<string | null> => {
    if (folderIds.has(path)) return folderIds.get(path)!;
    const parts = path.split("/");
    const parentId = await ensureFolder(parts.slice(0, -1).join("/"));
    console.log(`[seed] mkdir ${path}/${parentId ? "" : " (top-level)"}${dryRun ? " [dry-run]" : ""}`);
    const id = dryRun
      ? `dry_${path}`
      : (
          await api<{ data: { id: string } }>("POST", "/folders", {
            name: parts.at(-1),
            ...(parentId ? { parentId } : {}),
          })
        ).data.id;
    folderIds.set(path, id);
    return id;
  };
  for (const [p, content] of files) {
    const dir = p.split("/").slice(0, -1).join("/");
    const name = p.split("/").at(-1)!;
    const folderId = await ensureFolder(dir);
    console.log(`[seed] create ${p} (${content.length} chars)${dryRun ? " [dry-run]" : ""}`);
    if (!dryRun) await api("POST", "/files", { folderId, name, type: ".md", content });
  }

  // 4. Verify: the tree now holds exactly the fixture files under edge/ and no edge/memory.
  if (!dryRun) {
    const after = await api<{ data: { folders: Folder[] } }>("GET", "");
    const edge =
      after.data.folders.find((f) => f.name === PLANE_ROOT) ??
      after.data.folders.flatMap((r) => r.subfolders).find((f) => f.name === PLANE_ROOT);
    const list = (f: Folder, prefix: string): string[] => [
      ...f.files.filter((x) => x.name !== "index.md").map((x) => `${prefix}${f.name}/${x.name}`),
      ...f.subfolders.flatMap((s) => list(s, `${prefix}${f.name}/`)),
    ];
    const got = edge ? list(edge, "").sort() : [];
    const want = files.map(([p]) => p).sort();
    const same = JSON.stringify(got) === JSON.stringify(want);
    console.log(`[seed] verify: ${got.length} files ${same ? "✓ match fixtures" : "✗ MISMATCH"}`);
    if (!same) {
      console.error("  got: ", got, "\n  want:", want);
      process.exit(1);
    }
  }
  console.log(`[seed] done · horizontal_ctx_version=${version}`);
}

// Only run when executed directly — edge-version.ts imports the helpers above.
if (process.argv[1] && /edge-seed-plane\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error("[seed] failed:", e);
    process.exit(1);
  });
}
