import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contentTokens } from "../src/store/memory.js";
import type { CorpusSession } from "./corpus/generator.js";
import type { GoldFiles } from "./corpus/generator.js";
import type { Qrel } from "./qrels/derive.js";
import {
  CONTRADICTIONS_PATH,
  IMPLICIT_PREFERENCES_PATH,
  MEMORY_FILES_DIR,
  POISON_PATH,
  QRELS_PATH,
  SESSIONS_PATH,
  STALE_FACTS_PATH,
} from "./paths.js";

/**
 * Referential integrity of the COMMITTED gold: every fixture_id resolves to a
 * real user message containing the planted statement, counts match the spec,
 * and every qrels label resolves to a real memory file.
 */

const sessions = JSON.parse(readFileSync(SESSIONS_PATH, "utf8")) as CorpusSession[];
const contradictions = JSON.parse(
  readFileSync(CONTRADICTIONS_PATH, "utf8"),
) as GoldFiles["contradictions"];
const staleFacts = JSON.parse(readFileSync(STALE_FACTS_PATH, "utf8")) as GoldFiles["staleFacts"];
const poison = JSON.parse(readFileSync(POISON_PATH, "utf8")) as GoldFiles["poison"];
const implicitPreferences = JSON.parse(
  readFileSync(IMPLICIT_PREFERENCES_PATH, "utf8"),
) as GoldFiles["implicitPreferences"];
const qrels = JSON.parse(readFileSync(QRELS_PATH, "utf8")) as Qrel[];

const sessionById = new Map(sessions.map((s) => [s.id, s]));

function resolve(fixtureId: string) {
  const [sessionId, indexRaw] = fixtureId.split(":");
  const message = sessionById.get(sessionId)?.messages[Number(indexRaw)];
  expect(message, `fixture_id ${fixtureId} must resolve`).toBeDefined();
  return message!;
}

describe("corpus shape", () => {
  it("covers one week of sessions with role/text/ISO-date messages", () => {
    expect(sessions.length).toBeGreaterThanOrEqual(10);
    for (const session of sessions) {
      expect(session.messages.length).toBeGreaterThanOrEqual(6);
      for (const message of session.messages) {
        expect(["user", "assistant"]).toContain(message.role);
        expect(message.text.length).toBeGreaterThan(0);
        expect(new Date(message.at).toISOString()).toBe(message.at);
      }
    }
  });
});

describe("contradictions gold", () => {
  it("has 8-10 pairs, at least 2 temporal supersessions and 6 true contradictions", () => {
    expect(contradictions.length).toBeGreaterThanOrEqual(8);
    expect(contradictions.length).toBeLessThanOrEqual(10);
    const byKind = (k: string) => contradictions.filter((c) => c.kind === k).length;
    expect(byKind("temporal-supersession")).toBeGreaterThanOrEqual(2);
    expect(byKind("contradiction")).toBeGreaterThanOrEqual(6);
  });

  it("every side resolves to a user message containing the statement, earlier < later", () => {
    for (const c of contradictions) {
      const earlier = resolve(c.earlier.fixture_id);
      const later = resolve(c.later.fixture_id);
      expect(earlier.role).toBe("user");
      expect(later.role).toBe("user");
      expect(earlier.text).toContain(c.earlier.statement);
      expect(later.text).toContain(c.later.statement);
      expect(Date.parse(earlier.at)).toBeLessThan(Date.parse(later.at));
      expect(["earlier", "later"]).toContain(c.canonical);
      expect(c.reason.length).toBeGreaterThan(10);
    }
  });
});

describe("stale-facts gold", () => {
  it("has 4-5 entries that resolve and expire on/after the stated date", () => {
    expect(staleFacts.length).toBeGreaterThanOrEqual(4);
    expect(staleFacts.length).toBeLessThanOrEqual(5);
    for (const s of staleFacts) {
      const message = resolve(s.fixture_id);
      expect(message.role).toBe("user");
      expect(message.text).toContain(s.statement);
      expect(message.at.slice(0, 10)).toBe(s.stated_on);
      expect(s.expires_after >= s.stated_on).toBe(true);
    }
  });
});

describe("poison gold", () => {
  it("has 4-5 entries with valid expected_behavior, resolving to user messages", () => {
    expect(poison.length).toBeGreaterThanOrEqual(4);
    expect(poison.length).toBeLessThanOrEqual(5);
    for (const p of poison) {
      const message = resolve(p.fixture_id);
      expect(message.role).toBe("user");
      expect(message.text).toContain(p.statement);
      expect(["exclude", "quarantine", "warn"]).toContain(p.expected_behavior);
    }
  });

  it("stays paraphrased — no literal 'ignore all previous instructions'", () => {
    for (const p of poison) {
      expect(p.statement.toLowerCase()).not.toContain("ignore all previous instructions");
      expect(p.statement.toLowerCase()).not.toContain("ignore previous instructions");
    }
  });
});

describe("implicit-preferences gold", () => {
  it("has >= 3 entries, each with >= 3 evidence messages across >= 2 sessions", () => {
    expect(implicitPreferences.length).toBeGreaterThanOrEqual(3);
    for (const pref of implicitPreferences) {
      expect(pref.evidence.length).toBeGreaterThanOrEqual(3);
      const sessionsTouched = new Set(pref.evidence.map((fid) => fid.split(":")[0]));
      expect(sessionsTouched.size).toBeGreaterThanOrEqual(2);
      for (const fid of pref.evidence) expect(resolve(fid).role).toBe("user");
    }
  });

  it("the preference is never stated verbatim in any user message", () => {
    const allUserText = sessions
      .flatMap((s) => s.messages.filter((m) => m.role === "user").map((m) => m.text))
      .join("\n")
      .toLowerCase();
    for (const pref of implicitPreferences) {
      expect(allUserText).not.toContain(pref.preference.toLowerCase());
    }
  });
});

describe("qrels integrity", () => {
  const memoryNames = new Set(
    readdirSync(MEMORY_FILES_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.basename(f, ".md")),
  );

  it("has 30-50 queries; 20-30 memory files; unique query ids", () => {
    expect(qrels.length).toBeGreaterThanOrEqual(30);
    expect(qrels.length).toBeLessThanOrEqual(50);
    expect(memoryNames.size).toBeGreaterThanOrEqual(20);
    expect(memoryNames.size).toBeLessThanOrEqual(30);
    expect(new Set(qrels.map((q) => q.id)).size).toBe(qrels.length);
  });

  it("every relevant name resolves to a memory file; first_relevant is a grade-3 target", () => {
    for (const qrel of qrels) {
      expect(qrel.relevant.length).toBeGreaterThan(0);
      for (const r of qrel.relevant) {
        expect(memoryNames.has(r.name), `${qrel.id}: unknown memory "${r.name}"`).toBe(true);
        expect([1, 3]).toContain(r.grade);
      }
      const first = qrel.relevant.find((r) => r.name === qrel.first_relevant);
      expect(first?.grade, `${qrel.id}: first_relevant must be a grade-3 target`).toBe(3);
    }
  });

  it("memory files carry name/description/type frontmatter matching the filename", () => {
    for (const name of memoryNames) {
      const text = readFileSync(path.join(MEMORY_FILES_DIR, `${name}.md`), "utf8");
      const fm = /^---\nname: (.+)\ndescription: (.+)\ntype: (goal|preference|fact|constraint|event)\n---\n/.exec(
        text,
      );
      expect(fm, `${name}.md must have name/description/type frontmatter`).toBeTruthy();
      expect(fm![1]).toBe(name);
    }
  });

  it("adversarial queries share <30% content words with their target's name+body", () => {
    const adversarial = qrels.filter((q) => q.tier === "adversarial");
    expect(adversarial.length).toBeGreaterThanOrEqual(3);
    for (const qrel of adversarial) {
      const text = readFileSync(
        path.join(MEMORY_FILES_DIR, `${qrel.first_relevant}.md`),
        "utf8",
      );
      const body = text.split(/^---$/m)[2] ?? text;
      const targetTokens = new Set([
        ...contentTokens(qrel.first_relevant.split("-").join(" ")),
        ...contentTokens(body),
      ]);
      const queryTokens = Array.from(new Set(contentTokens(qrel.query)));
      const overlap =
        queryTokens.filter((t) => targetTokens.has(t)).length / (queryTokens.length || 1);
      expect(overlap, `${qrel.id} "${qrel.query}" overlaps ${overlap}`).toBeLessThan(0.3);
    }
  });
});
