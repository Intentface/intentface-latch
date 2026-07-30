import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { MEMORY_FILES_DIR } from "../paths.js";
import { createLiveStore, LIVE_SCOPE } from "./live-store.js";

/**
 * Seed the live Loredex eval workspace (`pnpm eval:seed-live`) with the SAME
 * committed reference memory files the offline eval uses, at the SAME paths
 * (`<scope.root>/memories/<name>.md`) — so the live benchmark measures only
 * the backend difference, never a corpus difference.
 *
 * Idempotent-by-tolerance: an already-existing file is skipped (Loredex
 * `create` errors on duplicates). If fixtures ever change, delete the
 * `_memory` folder in the workspace and re-seed.
 */

async function main(): Promise<void> {
  const fixtures = readdirSync(MEMORY_FILES_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
  if (fixtures.length === 0) throw new Error(`no fixtures in ${MEMORY_FILES_DIR}`);

  const { open } = await createLiveStore();
  const conn = await open();
  try {
    // Folder chain: _memory → running-coach → u-eval → memories.
    const dir = `${LIVE_SCOPE.root}/memories`;
    const parts = dir.split("/");
    for (let i = 0; i < parts.length; i++) {
      const parentId = parts.slice(0, i).join("/") || undefined;
      const res = await conn.call("create", {
        type: "folder",
        name: parts[i],
        ...(parentId ? { parentId } : {}),
      });
      // "Already exists" is the normal re-run case; anything else is fatal.
      if (!res.ok && !/exist/i.test(res.text)) {
        throw new Error(`creating folder "${parts[i]}" failed: ${res.text}`);
      }
    }

    let created = 0;
    let skipped = 0;
    for (const file of fixtures) {
      // Read-first idempotency: a resolvable path means the file exists —
      // no parsing of the create tool's error wording for the skip path.
      const existing = await conn.call("read_file", { fileId: `${dir}/${file}` });
      if (existing.ok) {
        skipped++;
        console.log(`  exists  ${dir}/${file} (skipped)`);
        continue;
      }
      const content = readFileSync(path.join(MEMORY_FILES_DIR, file), "utf8");
      const summaryLine =
        content
          .split("\n")
          .find((l) => l.startsWith("description:"))
          ?.slice("description:".length)
          .trim() ?? path.basename(file, ".md");
      const res = await conn.call("create", {
        type: "file",
        name: file,
        folderId: dir,
        content,
        summary: summaryLine,
      });
      if (!res.ok) throw new Error(`creating "${file}" failed: ${res.text}`);
      created++;
      console.log(`  created ${dir}/${file}`);
    }
    console.log(`\nseeded ${created} file(s), ${skipped} already present, of ${fixtures.length}.`);
  } finally {
    await conn.close();
  }
}

await main();
