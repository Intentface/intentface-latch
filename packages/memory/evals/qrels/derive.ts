import { contentTokens } from "../../src/store/memory.js";
import { MEMORY_FILES } from "./memories.js";
import type { MemoryFileDef } from "./memories.js";

/**
 * qrels derivation. Most queries are derived MECHANICALLY from the memory
 * frontmatter (name paraphrase / description keywords / body phrase) so the
 * benchmark can't quietly overfit to hand-tuned phrasing; a small adversarial
 * tier is hand-authored to share <30% content words with its target (enforced
 * by `gold-integrity.test.ts`) — those are EXPECTED to score poorly on
 * keyword search and are reported separately.
 */

export type QrelTier =
  | "name-paraphrase"
  | "description-keywords"
  | "body-phrase"
  | "adversarial";

export interface Qrel {
  id: string;
  tier: QrelTier;
  query: string;
  /** Graded relevance: target = 3, related = 1. */
  relevant: Array<{ name: string; grade: 1 | 3 }>;
  /** The primary target — what a perfect top-1 result returns. */
  first_relevant: string;
}

/**
 * Fixed word-substitution table for the mechanical "name paraphrase" tier.
 * Deliberately light: distinctive tokens (riverdale, achilles, 10k) pass
 * through so the tier measures ordinary keyword retrieval, not adversarial
 * rewording (that's what the adversarial tier is for).
 */
const SYNONYMS: Record<string, string> = {
  prefers: "likes",
  runs: "running",
  goal: "target",
  favorite: "preferred",
  owns: "has",
  trains: "training",
  blocked: "unavailable",
  window: "period",
  fueling: "nutrition",
  weekly: "week",
};

function nameParaphrase(def: MemoryFileDef): string {
  return def.name
    .split("-")
    .map((token) => SYNONYMS[token] ?? token)
    .join(" ");
}

function descriptionKeywords(def: MemoryFileDef): string {
  return Array.from(new Set(contentTokens(def.description))).slice(0, 6).join(" ");
}

function bodyPhrase(def: MemoryFileDef): string {
  const sentences = def.body.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  const sentence = sentences[1] ?? sentences[0] ?? def.body;
  return Array.from(new Set(contentTokens(sentence))).slice(0, 8).join(" ");
}

const MODES = [
  { tier: "name-paraphrase" as const, derive: nameParaphrase },
  { tier: "description-keywords" as const, derive: descriptionKeywords },
  { tier: "body-phrase" as const, derive: bodyPhrase },
];

/** Hand-maintained grade-1 neighbors (memories a query's target overlaps with). */
const RELATED: Record<string, string[]> = {
  "race-riverdale-spring-10k": ["goal-sub-48-spring-10k"],
  "goal-sub-48-spring-10k": ["race-riverdale-spring-10k"],
  "achilles-flare-history": ["physio-northside-achilles"],
  "physio-northside-achilles": ["achilles-flare-history"],
  "easy-pace-six-minutes": ["tempo-pace-four-fifty"],
  "tempo-pace-four-fifty": ["easy-pace-six-minutes"],
  "long-runs-on-sunday": ["favorite-route-river-loop", "electrolytes-on-long-runs"],
  "work-trip-treadmill-window": ["office-gym-treadmill"],
  "sleep-target-seven-and-a-half": ["no-caffeine-after-noon"],
  "no-caffeine-after-noon": ["sleep-target-seven-and-a-half"],
};

/**
 * Hand-authored adversarial queries: paraphrases sharing (almost) no content
 * words with the target's name+body. Keyword search is expected to miss these.
 */
export const ADVERSARIAL_QUERIES: ReadonlyArray<{ query: string; target: string }> = [
  { query: "what time of day does the athlete like to lace up", target: "trains-early-morning" },
  { query: "post lunch coffee rule", target: "no-caffeine-after-noon" },
  { query: "footwear worn for jogging", target: "shoes-cloudfoam-peak-3" },
  { query: "how much shut eye does the user try to get", target: "sleep-target-seven-and-a-half" },
  { query: "weekly workout summary formatting taste", target: "prefers-bullet-plans" },
];

function relevanceFor(target: string): Pick<Qrel, "relevant" | "first_relevant"> {
  return {
    relevant: [
      { name: target, grade: 3 },
      ...(RELATED[target] ?? []).map((name) => ({ name, grade: 1 as const })),
    ],
    first_relevant: target,
  };
}

export function deriveQrels(): Qrel[] {
  const qrels: Qrel[] = [];
  const push = (tier: QrelTier, query: string, target: string) => {
    qrels.push({
      id: `q${String(qrels.length + 1).padStart(2, "0")}`,
      tier,
      query,
      ...relevanceFor(target),
    });
  };

  // One mechanical query per memory, cycling derivation modes.
  MEMORY_FILES.forEach((def, i) => {
    const mode = MODES[i % MODES.length];
    push(mode.tier, mode.derive(def), def.name);
  });
  // A second mechanical query (different mode) for the first eight memories.
  MEMORY_FILES.slice(0, 8).forEach((def, i) => {
    const mode = MODES[(i + 2) % MODES.length];
    push(mode.tier, mode.derive(def), def.name);
  });
  for (const adv of ADVERSARIAL_QUERIES) push("adversarial", adv.query, adv.target);

  return qrels;
}
