import { createHash } from "node:crypto";
import { mulberry32, int } from "./prng.js";
import type { Rng } from "./prng.js";
import { SESSION_SCRIPTS } from "./script.js";
import { CONTRADICTIONS, IMPLICIT_PREFERENCES, POISON, STALE_FACTS } from "./plants.js";

/**
 * Deterministic synthetic-corpus generator. `buildCorpus(seed)` is a pure
 * function of the seed: same seed → byte-identical fixtures (guarded by
 * `determinism.test.ts`). The committed fixtures use `CORPUS_SEED`.
 */

export const CORPUS_SEED = 42;
export const GENERATOR_VERSION = "1.0.0";

export interface CorpusMessage {
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface CorpusSession {
  id: string;
  title: string;
  startsAt: string;
  messages: CorpusMessage[];
}

export interface Corpus {
  persona: { user: string; agent: string };
  week: { from: string; to: string };
  sessions: CorpusSession[];
  /** Plant key (`contra-01:earlier`, `stale-01`, `implicit-01`…) → fixture_ids. */
  plantIndex: Map<string, string[]>;
}

/** `<sessionId>:<messageIndex>` — how gold entries reference corpus messages. */
export function fixtureId(sessionId: string, messageIndex: number): string {
  return `${sessionId}:${messageIndex}`;
}

export function buildCorpus(seed: number): Corpus {
  const rng: Rng = mulberry32(seed);
  const sessions: CorpusSession[] = [];
  const plantIndex = new Map<string, string[]>();

  for (const script of SESSION_SCRIPTS) {
    let atMs = Date.parse(script.startsAt);
    const messages: CorpusMessage[] = [];
    for (const turn of script.turns) {
      const index = messages.length;
      // PRNG drives filler variation and spacing only — plant turns are
      // always fixed strings, so gold content never depends on the seed.
      const text = typeof turn.text === "function" ? turn.text(rng) : turn.text;
      messages.push({ role: turn.role, text, at: new Date(atMs).toISOString() });
      atMs += (45 + int(rng, 0, 90)) * 1000;
      if (turn.plant) {
        const ids = plantIndex.get(turn.plant) ?? [];
        ids.push(fixtureId(script.id, index));
        plantIndex.set(turn.plant, ids);
      }
    }
    sessions.push({ id: script.id, title: script.title, startsAt: script.startsAt, messages });
  }

  return {
    persona: { user: "Jamie (placeholder)", agent: "running-coach" },
    week: { from: "2026-03-02", to: "2026-03-08" },
    sessions,
    plantIndex,
  };
}

// ---------------------------------------------------------------------------
// Gold files
// ---------------------------------------------------------------------------

export interface GoldFiles {
  contradictions: Array<{
    id: string;
    kind: "contradiction" | "temporal-supersession";
    earlier: { fixture_id: string; statement: string };
    later: { fixture_id: string; statement: string };
    canonical: "earlier" | "later";
    reason: string;
  }>;
  staleFacts: Array<{
    id: string;
    fixture_id: string;
    statement: string;
    stated_on: string;
    expires_after: string;
    note: string;
  }>;
  poison: Array<{
    id: string;
    fixture_id: string;
    statement: string;
    vector: string;
    expected_behavior: "exclude" | "quarantine" | "warn";
    note: string;
  }>;
  implicitPreferences: Array<{
    id: string;
    preference: string;
    evidence: string[];
    note: string;
  }>;
}

function only(plantIndex: Map<string, string[]>, key: string): string {
  const ids = plantIndex.get(key);
  if (!ids || ids.length !== 1) {
    throw new Error(`plant "${key}" resolved to ${ids?.length ?? 0} fixtures (expected 1)`);
  }
  return ids[0];
}

export function buildGold(corpus: Corpus): GoldFiles {
  const { plantIndex, sessions } = corpus;
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const dateOf = (fid: string): string => {
    const [sid, idx] = fid.split(":");
    const message = sessionById.get(sid)?.messages[Number(idx)];
    if (!message) throw new Error(`fixture_id does not resolve: ${fid}`);
    return message.at.slice(0, 10);
  };

  return {
    contradictions: CONTRADICTIONS.map((c) => ({
      id: c.id,
      kind: c.kind,
      earlier: { fixture_id: only(plantIndex, `${c.id}:earlier`), statement: c.earlier },
      later: { fixture_id: only(plantIndex, `${c.id}:later`), statement: c.later },
      canonical: c.canonical,
      reason: c.reason,
    })),
    staleFacts: STALE_FACTS.map((s) => {
      const fid = only(plantIndex, s.id);
      return {
        id: s.id,
        fixture_id: fid,
        statement: s.statement,
        stated_on: dateOf(fid),
        expires_after: s.expiresAfter,
        note: s.note,
      };
    }),
    poison: POISON.map((p) => ({
      id: p.id,
      fixture_id: only(plantIndex, p.id),
      statement: p.statement,
      vector: p.vector,
      expected_behavior: p.expectedBehavior,
      note: p.note,
    })),
    implicitPreferences: IMPLICIT_PREFERENCES.map((p) => {
      const ids = corpus.plantIndex.get(p.id) ?? [];
      if (ids.length !== p.evidence.length) {
        throw new Error(
          `implicit plant "${p.id}": ${ids.length} evidence fixtures, expected ${p.evidence.length}`,
        );
      }
      return { id: p.id, preference: p.preference, evidence: ids, note: p.note };
    }),
  };
}

// ---------------------------------------------------------------------------
// Manifest + serialization
// ---------------------------------------------------------------------------

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Stable serialization for every committed fixture: 2-space JSON + trailing \n. */
export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export interface CorpusManifest {
  generator_version: string;
  seed: number;
  /** sha256 of the serialized sessions array — the template/content hash. */
  corpus_sha256: string;
  sessions: Array<{ id: string; messages: number; sha256: string }>;
}

export function buildManifest(corpus: Corpus): CorpusManifest {
  return {
    generator_version: GENERATOR_VERSION,
    seed: CORPUS_SEED,
    corpus_sha256: sha256(serialize(corpus.sessions)),
    sessions: corpus.sessions.map((s) => ({
      id: s.id,
      messages: s.messages.length,
      sha256: sha256(serialize(s)),
    })),
  };
}
