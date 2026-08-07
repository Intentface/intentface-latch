import { describe, expect, it } from "vitest";
import { nextAskStep, resolveTypedAnswer } from "./ask.js";
import type { AskSession, Question } from "./types.js";

const opt = (label: string) => ({ label, description: `about ${label}` });

const single: Question = { question: "Goal?", options: [opt("Speed"), opt("Finish")] };
const multi: Question = {
  question: "Which?",
  multiSelect: true,
  options: [opt("Trail"), opt("Road"), opt("Track")],
};

function session(questions: Question[], over: Partial<AskSession> = {}): AskSession {
  return {
    toolCallId: "toolu_1",
    nonce: "abc123",
    questions,
    cursor: 0,
    answers: {},
    selected: [],
    promptChatId: "5",
    rev: 0,
    ...over,
  };
}

describe("nextAskStep: single-select", () => {
  it("a pick on the only question completes with the answer map", () => {
    const step = nextAskStep(session([single]), { kind: "pick", option: 0 });
    expect(step).toEqual({
      kind: "completed",
      output: { "Goal?": "Speed" },
      answered: { question: "Goal?", answer: "Speed" },
    });
  });

  it("a pick with more questions left advances and carries answers forward", () => {
    const step = nextAskStep(session([single, multi]), { kind: "pick", option: 1 });
    expect(step).toEqual({
      kind: "advanced",
      cursor: 1,
      answers: { "Goal?": "Finish" },
      answered: { question: "Goal?", answer: "Finish" },
    });
  });

  it("the final answer's output includes every earlier answer", () => {
    const s = session([single, { ...single, question: "Second?" }], {
      cursor: 1,
      answers: { "Goal?": "Speed" },
    });
    const step = nextAskStep(s, { kind: "pick", option: 0 });
    expect(step.kind).toBe("completed");
    expect(step.kind === "completed" && step.output).toEqual({
      "Goal?": "Speed",
      "Second?": "Speed",
    });
  });

  it("rejects an option index that no longer exists", () => {
    expect(nextAskStep(session([single]), { kind: "pick", option: 9 }).kind).toBe("rejected");
  });

  it("rejects Done on a single-select question", () => {
    expect(nextAskStep(session([single]), { kind: "done" }).kind).toBe("rejected");
  });
});

describe("nextAskStep: multi-select", () => {
  it("a pick toggles instead of committing", () => {
    expect(nextAskStep(session([multi]), { kind: "pick", option: 1 })).toEqual({
      kind: "toggled",
      selected: [1],
    });
  });

  it("toggling an already-ticked option un-ticks it", () => {
    const s = session([multi], { selected: [0, 2] });
    expect(nextAskStep(s, { kind: "pick", option: 0 })).toEqual({ kind: "toggled", selected: [2] });
  });

  it("Done joins the ticks in OPTION order, not tap order", () => {
    const s = session([multi], { selected: [2, 0] }); // tapped Track then Trail
    const step = nextAskStep(s, { kind: "done" });
    expect(step.kind === "completed" && step.output).toEqual({ "Which?": "Trail, Track" });
  });

  it("Done with nothing ticked is rejected rather than answering empty", () => {
    const step = nextAskStep(session([multi]), { kind: "done" });
    expect(step).toMatchObject({ kind: "rejected" });
  });
});

describe("nextAskStep: typed answers", () => {
  it("matches an option label case-insensitively", () => {
    const step = nextAskStep(session([single]), { kind: "typed", text: "speed" });
    expect(step.kind === "completed" && step.output).toEqual({ "Goal?": "Speed" });
  });

  it("accepts a 1-based option number", () => {
    const step = nextAskStep(session([single]), { kind: "typed", text: "2" });
    expect(step.kind === "completed" && step.output).toEqual({ "Goal?": "Finish" });
  });

  it("keeps free-form text verbatim when it matches no option", () => {
    const step = nextAskStep(session([single]), { kind: "typed", text: "somewhere in between" });
    expect(step.kind === "completed" && step.output).toEqual({ "Goal?": "somewhere in between" });
  });

  it("an index list replaces the ticks on a multi-select question", () => {
    const s = session([multi], { selected: [0] });
    const step = nextAskStep(s, { kind: "typed", text: "2,3" });
    expect(step.kind === "completed" && step.output).toEqual({ "Which?": "Road, Track" });
  });

  it("free text on a multi-select is APPENDED to the ticks, as the web composer does", () => {
    const s = session([multi], { selected: [0, 2] });
    const step = nextAskStep(s, { kind: "typed", text: "and also cross-country" });
    expect(step.kind === "completed" && step.output).toEqual({
      "Which?": "Trail, Track, and also cross-country",
    });
  });

  it("rejects whitespace-only text instead of committing an empty answer", () => {
    expect(nextAskStep(session([single]), { kind: "typed", text: "   " }).kind).toBe("rejected");
  });
});

describe("resolveTypedAnswer", () => {
  it("treats an out-of-range number as free text, not an option", () => {
    expect(resolveTypedAnswer(single, "0")).toBe("0");
    expect(resolveTypedAnswer(single, "99")).toBe("99");
  });

  it("does not treat a multi-number reply to a single-select as a list", () => {
    expect(resolveTypedAnswer(single, "1,2")).toBe("1,2");
  });
});

describe("nextAskStep: edge cases", () => {
  it("rejects any event once the cursor is past the last question", () => {
    const s = session([single], { cursor: 1 });
    expect(nextAskStep(s, { kind: "pick", option: 0 }).kind).toBe("rejected");
  });

  it("two questions with identical text collapse to one key — last wins", () => {
    // Unavoidable: the tool's output contract is a flat map keyed by question
    // text (the web composer has the same property). Pinned so it can't surprise.
    const dup: Question = { ...single, question: "Same?" };
    const s = session([dup, { ...dup }], { cursor: 1, answers: { "Same?": "Speed" } });
    const step = nextAskStep(s, { kind: "pick", option: 1 });
    expect(step.kind === "completed" && step.output).toEqual({ "Same?": "Finish" });
  });
});
