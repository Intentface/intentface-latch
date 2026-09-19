import { describe, expect, it } from "vitest";
import type { AttachedEval } from "../agent-store";
import { validateRubrics } from "./rubrics";

const anyModel = () => true;

const rubric = (over: Partial<AttachedEval> = {}): AttachedEval => ({
  name: "stays-on-topic",
  prompt: "Stays on topic.",
  scale: "binary",
  enabled: true,
  ...over,
});

describe("validateRubrics — trigger/context", () => {
  it("accepts a legacy rubric with neither field (back-compat)", () => {
    const res = validateRubrics([rubric()], anyModel);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rubrics[0]).not.toHaveProperty("trigger");
      expect(res.rubrics[0]).not.toHaveProperty("context");
    }
  });

  it("preserves a valid trigger and context in the cleaned output", () => {
    const res = validateRubrics(
      [rubric({ trigger: { kind: "turn", eq: 1 }, context: "chat" })],
      anyModel,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rubrics[0].trigger).toEqual({ kind: "turn", eq: 1 });
      expect(res.rubrics[0].context).toBe("chat");
    }
  });

  it("rejects a malformed trigger with the rubric named", () => {
    const res = validateRubrics(
      [rubric({ trigger: { kind: "sometimes" } as never })],
      anyModel,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/stays-on-topic.*unknown trigger kind/);
  });

  it("rejects an unknown context scope", () => {
    const res = validateRubrics([rubric({ context: "everything" as never })], anyModel);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Invalid context/);
  });
});

/**
 * The real draft the Eval Author produced for "agent should always use tool to
 * get the data, and also follow the given style when answering" — an "and"
 * joining two separable qualities, which it duly crammed into one rubric that
 * ran past the length cap and could not be saved.
 */
const BUNDLED_PROMPT = `Evaluate TWO things together and pass only if BOTH are satisfied:

1. TOOL USE — The agent must have called the \`fetch_top_hn_posts\` tool before delivering its digest answer. If no tool call is present (i.e., the agent answered from memory or made up data), fail immediately.

2. STYLE COMPLIANCE — The agent's response must follow ALL of the formatting rules below:
   - Posts are numbered 1–5.
   - Each title is rendered as a clickable markdown link pointing to the article URL.
   - Each entry includes a 1–2 sentence summary of the post.
   - Each entry shows the upvote score with a ⬆️ emoji and the comment count with a 💬 emoji, along with a link to the HN discussion.
   - Entries are clearly separated from one another.
   - Tone is informative and neutral — no unnecessary filler or fluff.

If the user message is a follow-up question (not a request for a digest), only criterion 1 is evaluated: did the agent avoid fabricating data that should require the tool?

Return 1 (pass) only if both criteria are fully met. Return 0 (fail) if either criterion is violated.`;

describe("validateRubrics — the bundled-quality draft", () => {
  it("rejects it, naming the rubric so the error is actionable", () => {
    const res = validateRubrics([rubric({ name: "tool-use-and-style-compliance", prompt: BUNDLED_PROMPT })], anyModel);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/over 1000 chars: tool-use-and-style-compliance/);
  });

  it("accepts the same intent split into the two qualities it was always measuring", () => {
    // The length cap is doing a second job here: a prompt that cannot fit is
    // usually measuring more than one thing, and splitting it gives two scores
    // you can act on separately. A bundled 0 never says WHICH half broke — the
    // run that invented the data and the run that merely misformatted it are
    // recorded identically.
    const res = validateRubrics(
      [
        rubric({
          name: "uses-hn-tool",
          prompt:
            "The agent called the fetch_top_hn_posts tool before answering with post data, rather than " +
            "producing titles, scores or comment counts without a tool call.",
        }),
        rubric({
          name: "follows-digest-format",
          prompt:
            "The digest numbers posts 1-5, links each title as markdown, gives a 1-2 sentence summary, and " +
            "shows the score and comment count with a link to the HN discussion. Neutral tone, no filler.",
        }),
      ],
      anyModel,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rubrics.map((r) => r.name)).toEqual(["uses-hn-tool", "follows-digest-format"]);
  });

  it("holds every prompt under the cap, so a draft is never shown that cannot be saved", () => {
    const long = rubric({ name: "a", prompt: "x".repeat(1001) });
    expect(validateRubrics([long], anyModel).ok).toBe(false);
    expect(validateRubrics([rubric({ name: "a", prompt: "x".repeat(1000) })], anyModel).ok).toBe(true);
  });
});
