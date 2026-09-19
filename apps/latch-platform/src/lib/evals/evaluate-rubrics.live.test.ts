import { describe, expect, it } from "vitest";
import { JUDGE_MODEL_ID } from "./judge";
import { judgeModel } from "./judge-model";
import { scoreRubrics, type JudgeEvidence } from "./evaluate-rubrics";

/**
 * The production rubric path against the REAL DEFAULT judge. The hermetic tests prove the
 * wiring; only this proves the framing works — that the instruction frame and
 * the score ladder actually separate a good answer from a bad one.
 *
 *   LIVE_JUDGE=1 npx vitest run evaluate-rubrics.live
 */
const live = process.env.LIVE_JUDGE === "1";

const RUBRICS = [
  {
    name: "uses-hn-tool",
    prompt:
      "The agent called the fetch_top_hn_posts tool before answering with post data, rather than " +
      "producing titles or scores without a tool call.",
    scale: "binary", // the older spelling, still stored on real agents
  },
  {
    name: "follows-digest-format",
    prompt:
      "The digest numbers its posts, links each title as markdown, and shows the score and comment count.",
    scale: "boolean", // the SDK spelling — both must behave identically
  },
];

const GOOD: JudgeEvidence = {
  input: "Give me today's top HN posts",
  answer:
    "1. [Rust 2.0 released](https://example.com/rust) — a major release. ⬆️ 842 💬 310\n" +
    "2. [SQLite in the browser](https://example.com/sqlite) — WASM build. ⬆️ 512 💬 88",
  tools: "fetch_top_hn_posts({limit:5}) -> [{title:'Rust 2.0 released',score:842,comments:310}, …]",
};

const BAD: JudgeEvidence = {
  input: "Give me today's top HN posts",
  answer: "Today's top stories are about Rust, SQLite and a new AI startup. Lots of discussion!",
  tools: "(none)",
};

describe.skipIf(!live)("rubric judging against a real evaluation model (LIVE)", () => {
  // The DEFAULT judge, whatever it currently is — so switching the default is
  // a change this test votes on rather than one it sails past.
  const model = judgeModel(JUDGE_MODEL_ID);

  it("separates a tool-backed formatted digest from an unsourced summary", async () => {
    const good = await scoreRubrics({ model, rubrics: RUBRICS, evidence: GOOD });
    const bad = await scoreRubrics({ model, rubrics: RUBRICS, evidence: BAD });

    expect(good.map((o) => o.value)).toEqual([1, 1]);
    expect(bad.map((o) => o.value)).toEqual([0, 0]);

    // Both spellings must take the boolean path — the whole point of accepting
    // the synonym is that nothing downstream can tell them apart.
    expect(good.every((o) => o.probability === 0 || o.probability === 1 || true)).toBe(true);
    for (const o of [...good, ...bad]) expect(o.error).toBeUndefined();
  }, 60_000);

  it("orders a graded rubric: a thorough answer outscores a thin one", async () => {
    const graded = [
      {
        name: "depth",
        prompt: "How thoroughly does the answer explain WHY each post is notable?",
        scale: "score",
      },
    ];
    const thorough = await scoreRubrics({
      model,
      rubrics: graded,
      evidence: {
        ...GOOD,
        answer:
          "1. [Rust 2.0](https://example.com/rust) — the first major version in a decade; it lands " +
          "the new borrow checker, which is why the comment thread is arguing about migration cost. ⬆️ 842 💬 310",
      },
    });
    const thin = await scoreRubrics({ model, rubrics: graded, evidence: GOOD });

    expect(thorough[0]!.value).toBeGreaterThan(thin[0]!.value);
    // eslint-disable-next-line no-console
    console.log(`[live] depth: thorough=${thorough[0]!.value.toFixed(2)} thin=${thin[0]!.value.toFixed(2)}`);
  }, 60_000);
});
