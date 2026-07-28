import { fileURLToPath } from "node:url";
import path from "node:path";

/** Absolute fixture locations, shared by the generator, tests, and runner. */
const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURES_DIR = path.join(EVALS_DIR, "fixtures");
export const CORPUS_DIR = path.join(FIXTURES_DIR, "corpus");
export const GOLD_DIR = path.join(CORPUS_DIR, "gold");
export const MEMORY_FILES_DIR = path.join(FIXTURES_DIR, "memory-files");
export const RESULTS_DIR = path.join(EVALS_DIR, "results");

export const SESSIONS_PATH = path.join(CORPUS_DIR, "sessions.json");
export const MANIFEST_PATH = path.join(CORPUS_DIR, "corpus-manifest.json");
export const CONTRADICTIONS_PATH = path.join(GOLD_DIR, "contradictions.json");
export const STALE_FACTS_PATH = path.join(GOLD_DIR, "stale-facts.json");
export const POISON_PATH = path.join(GOLD_DIR, "poison.json");
export const IMPLICIT_PREFERENCES_PATH = path.join(GOLD_DIR, "implicit-preferences.json");
export const QRELS_PATH = path.join(FIXTURES_DIR, "qrels.json");
export const RESULTS_PATH = path.join(RESULTS_DIR, "memory-search-baseline.json");
