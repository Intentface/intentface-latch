import { describe, expect, it } from "vitest";
import type { Check } from "./model";
import { checkIdFor, nextInputId, validateChecks, validateInputs } from "./validate";

describe("questions", () => {
  it("trims, drops empty lists, and keeps unknown facts", () => {
    const r = validateInputs([
      { id: " 1 ", prompt: " Close ABC-12 ", followUps: ["", " why? "], facts: { answer: " ", mustNot: [" "], docs: ["a.md", ""], issueId: "ABC-12" } },
    ]);
    expect(r).toEqual({
      ok: true,
      value: [{ id: "1", prompt: "Close ABC-12", followUps: ["why?"], facts: { issueId: "ABC-12", calls: [{ tool: "*read_file", match: [{ path: "result", op: "contains", value: "a.md" }] }] } }],
    });
  });

  it("keeps an input's own judge questions that can pass and fail, and refuses one that can't", () => {
    const ok = validateInputs([{ id: "1", prompt: "Q", facts: { judged: [{ ask: " Tone? ", shape: { type: "choice", options: { warm: "Warm", cold: "Cold" }, bad: ["cold"] } }, { ask: " ", shape: { type: "boolean" } }] } }]);
    expect(ok.ok && ok.value[0].facts).toEqual({ judged: [{ ask: "Tone?", shape: { type: "choice", options: { warm: "Warm", cold: "Cold" }, bad: ["cold"] } }] });
    const bad = validateInputs([{ id: "1", prompt: "Q", facts: { judged: [{ ask: "Tone?", shape: { type: "choice", options: { warm: "Warm", cold: "Cold" }, bad: [] } }] } }]);
    expect(bad.ok).toBe(false);
  });

  it("cleans tags: trimmed, lower case, dashes for spaces, once each", () => {
    const r = validateInputs([{ id: "1", prompt: "Q", tags: [" PDF ", "hard case", "pdf", ""] }]);
    expect(r.ok && r.value[0].tags).toEqual(["pdf", "hard-case"]);
  });

  it("saves a document the answer is in as the read it expects, beside its other calls", () => {
    const read = { tool: "*read_file", match: [{ path: "result", op: "contains" as const, value: "a.md" }] };
    const r = validateInputs([{ id: "1", prompt: "Q", facts: { docs: ["a.md"], calls: [read, { tool: "send", never: true }] } }]);
    expect(r.ok && r.value[0].facts).toEqual({ calls: [read, { tool: "send", never: true }] });
  });

  it("refuses duplicates and empty questions, in words", () => {
    expect(validateInputs([{ id: "1", prompt: "a" }, { id: "1", prompt: "b" }])).toMatchObject({ ok: false, error: /share the id #1/ });
    expect(validateInputs([{ id: "1", prompt: "  " }])).toMatchObject({ ok: false, error: /has no question/ });
  });

  it("continues numbering", () => {
    expect(nextInputId([{ id: "1" }, { id: "23" }])).toBe("24");
    expect(nextInputId([{ id: "a" }])).toBe("q2");
    expect(nextInputId([])).toBe("1");
  });
});

describe("checks", () => {
  const asked = (shape: Extract<Check, { kind: "asked" }>["shape"]): Check => ({ kind: "asked", id: "x", label: "X", ask: "Did it?", shape });

  it("accepts the three shapes when they can both pass and fail", () => {
    expect(validateChecks([asked({ type: "boolean" })]).ok).toBe(true);
    expect(validateChecks([asked({ type: "choice", options: { a: "good", b: "bad" }, bad: ["b"] })]).ok).toBe(true);
  });

  it("refuses a pick-one where nothing, or everything, fails", () => {
    expect(validateChecks([asked({ type: "choice", options: { a: "good", b: "bad" }, bad: [] })])).toMatchObject({ ok: false, error: /nothing can fail/ });
    expect(validateChecks([asked({ type: "choice", options: { a: "x", b: "y" }, bad: ["a", "b"] })])).toMatchObject({ ok: false, error: /nothing can pass/ });
  });

  it("refuses a broken pattern and a missing tool", () => {
    const counted = (spec: Extract<Check, { kind: "counted" }>["spec"]): Check => ({ kind: "counted", id: "c", label: "C", spec });
    expect(validateChecks([counted({ op: "called_with", tool: "t", path: "id", match: { matches: "(" } })])).toMatchObject({ ok: false, error: /not a valid pattern/ });
    expect(validateChecks([counted({ op: "called", tool: " " })])).toMatchObject({ ok: false, error: /needs a tool name/ });
  });

  it("makes readable, unique ids", () => {
    expect(checkIdFor("Got the answer right!", [])).toBe("got-the-answer-right");
    expect(checkIdFor("Got the answer right", ["got-the-answer-right"])).toBe("got-the-answer-right-2");
    expect(checkIdFor("Provides a direct answer or recommendation rather than questions", [])).toBe("provides-a-direct-answer-or");
  });
});

describe("new input ids", () => {
  it("never reuse the id of a removed input that still has answers", async () => {
    const { nextInputId } = await import("./validate");
    expect(nextInputId([{ id: "1" }, { id: "2" }], ["3"])).toBe("4");
    expect(nextInputId([{ id: "1" }, { id: "2" }])).toBe("3");
  });
});
