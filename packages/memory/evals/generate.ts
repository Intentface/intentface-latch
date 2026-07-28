import { mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { buildCorpus, buildGold, buildManifest, CORPUS_SEED, serialize } from "./corpus/generator.js";
import { deriveQrels } from "./qrels/derive.js";
import { MEMORY_FILES, renderMemoryFile } from "./qrels/memories.js";
import {
  CONTRADICTIONS_PATH,
  CORPUS_DIR,
  GOLD_DIR,
  IMPLICIT_PREFERENCES_PATH,
  MANIFEST_PATH,
  MEMORY_FILES_DIR,
  POISON_PATH,
  QRELS_PATH,
  SESSIONS_PATH,
  STALE_FACTS_PATH,
} from "./paths.js";

/**
 * Regenerate every committed fixture from the deterministic sources
 * (`pnpm eval:regen-fixtures`). Output is byte-stable: same seed, same
 * templates → identical files. `determinism.test.ts` fails when the committed
 * fixtures drift from what this script would write.
 */

function write(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
  console.log(`wrote ${filePath}`);
}

const corpus = buildCorpus(CORPUS_SEED);
const gold = buildGold(corpus);

mkdirSync(CORPUS_DIR, { recursive: true });
mkdirSync(GOLD_DIR, { recursive: true });
write(SESSIONS_PATH, serialize(corpus.sessions));
write(MANIFEST_PATH, serialize(buildManifest(corpus)));
write(CONTRADICTIONS_PATH, serialize(gold.contradictions));
write(STALE_FACTS_PATH, serialize(gold.staleFacts));
write(POISON_PATH, serialize(gold.poison));
write(IMPLICIT_PREFERENCES_PATH, serialize(gold.implicitPreferences));

// Memory files: clear stale .md fixtures first so renames don't leave orphans.
mkdirSync(MEMORY_FILES_DIR, { recursive: true });
for (const existing of readdirSync(MEMORY_FILES_DIR)) {
  if (existing.endsWith(".md")) rmSync(path.join(MEMORY_FILES_DIR, existing));
}
for (const def of MEMORY_FILES) {
  write(path.join(MEMORY_FILES_DIR, `${def.name}.md`), renderMemoryFile(def));
}

write(QRELS_PATH, serialize(deriveQrels()));

console.log(
  `done: ${corpus.sessions.length} sessions, ${MEMORY_FILES.length} memory files, ${deriveQrels().length} qrels (seed ${CORPUS_SEED})`,
);
