import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCorpus, buildGold, buildManifest, CORPUS_SEED, serialize } from "./corpus/generator.js";
import { deriveQrels } from "./qrels/derive.js";
import { MEMORY_FILES, renderMemoryFile } from "./qrels/memories.js";
import {
  CONTRADICTIONS_PATH,
  IMPLICIT_PREFERENCES_PATH,
  MANIFEST_PATH,
  MEMORY_FILES_DIR,
  POISON_PATH,
  QRELS_PATH,
  SESSIONS_PATH,
  STALE_FACTS_PATH,
} from "./paths.js";

/**
 * Determinism + drift guards: the generator must be byte-deterministic for a
 * given seed, and the COMMITTED fixtures must be exactly what the generator
 * produces. If any of these fail after an intentional template change, run
 * `pnpm eval:regen-fixtures` and commit the diff.
 */

const read = (p: string) => readFileSync(p, "utf8");

describe("generator determinism", () => {
  it("seed 42 twice yields byte-identical output", () => {
    const a = buildCorpus(CORPUS_SEED);
    const b = buildCorpus(CORPUS_SEED);
    expect(serialize(a.sessions)).toBe(serialize(b.sessions));
    expect(serialize(buildGold(a))).toBe(serialize(buildGold(b)));
    expect(serialize(buildManifest(a))).toBe(serialize(buildManifest(b)));
  });

  it("a different seed yields different output (the seed is actually used)", () => {
    expect(serialize(buildCorpus(CORPUS_SEED).sessions)).not.toBe(
      serialize(buildCorpus(CORPUS_SEED + 1).sessions),
    );
  });
});

describe("committed fixtures match the generator (no drift)", () => {
  const corpus = buildCorpus(CORPUS_SEED);
  const gold = buildGold(corpus);

  it("sessions.json", () => {
    expect(read(SESSIONS_PATH)).toBe(serialize(corpus.sessions));
  });

  it("corpus-manifest.json (per-session sha256 + content hash)", () => {
    expect(read(MANIFEST_PATH)).toBe(serialize(buildManifest(corpus)));
  });

  it("gold files", () => {
    expect(read(CONTRADICTIONS_PATH)).toBe(serialize(gold.contradictions));
    expect(read(STALE_FACTS_PATH)).toBe(serialize(gold.staleFacts));
    expect(read(POISON_PATH)).toBe(serialize(gold.poison));
    expect(read(IMPLICIT_PREFERENCES_PATH)).toBe(serialize(gold.implicitPreferences));
  });

  it("qrels.json", () => {
    expect(read(QRELS_PATH)).toBe(serialize(deriveQrels()));
  });

  it("memory-files/*.md — exact file set, byte-identical contents", () => {
    const onDisk = readdirSync(MEMORY_FILES_DIR).filter((f) => f.endsWith(".md")).sort();
    const expected = MEMORY_FILES.map((d) => `${d.name}.md`).sort();
    expect(onDisk).toEqual(expected);
    for (const def of MEMORY_FILES) {
      expect(read(path.join(MEMORY_FILES_DIR, `${def.name}.md`))).toBe(renderMemoryFile(def));
    }
  });
});
